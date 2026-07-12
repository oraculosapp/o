-- =============================================================================
-- Phygitalia · o.Oraculos.app — Migración 0003: Endurecimiento de identidad
-- =============================================================================
-- Correcciones de seguridad del magno ejercicio (M-1 + M-4):
--   (a) CHECK de forma/longitud en `profiles` (handle, bio, location, website).
--   (b) Trigger en `biosphere_messages` que SOBREESCRIBE `display_name` con el
--       handle del perfil para usuarios registrados (no confiar en el cliente);
--       los anónimos conservan su display_name libre pero se marcan `is_anon`.
--   (c) Anti-suplantación barata: un anónimo no puede firmar como un Oráculo
--       (display_name que empiece por "Paqo"/nombres de Oráculo → se neutraliza).
--
-- Convenciones heredadas de 0001/0002:
--   · RLS ya activo; `auth.uid()` = usuario (incluye anónimos con sesión).
--   · Las inserciones del Oráculo las hace el servidor con service_role
--     (is_oracle = true); las de usuarios pasan por la RLS de 0001.
--
-- Idempotente: guarda cada objeto con IF NOT EXISTS / DO-guard / CREATE OR
-- REPLACE / DROP ... IF EXISTS. Segura de re-correr sobre una base con 0001+0002.
-- =============================================================================

-- =============================================================================
-- (a) CHECK de forma y longitud en profiles
-- =============================================================================
-- La app ya valida en cliente/servidor; estos CHECK son la red de seguridad de
-- la BD (defensa en profundidad). Se añaden sólo si no existen ya. Las columnas
-- bio/location/website son nullable: char_length(null) es null ⇒ el CHECK pasa.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_handle_format') then
    alter table public.profiles
      add constraint profiles_handle_format
      check (handle ~ '^[a-z0-9_-]{3,32}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_bio_len') then
    alter table public.profiles
      add constraint profiles_bio_len check (char_length(bio) <= 280);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_location_len') then
    alter table public.profiles
      add constraint profiles_location_len check (char_length(location) <= 120);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_website_len') then
    alter table public.profiles
      add constraint profiles_website_len check (char_length(website) <= 200);
  end if;
end
$$;

-- =============================================================================
-- (b+c) biosphere_messages: columna is_anon + trigger de identidad
-- =============================================================================

-- Columna is_anon: true = autor anónimo (sin perfil registrado). Default true
-- (el caso más común en el chat público); el trigger la fija en cada INSERT.
alter table public.biosphere_messages
  add column if not exists is_anon boolean not null default true;

comment on column public.biosphere_messages.is_anon is
  'true = autor anónimo. Lo fija el trigger enforce_biosphere_message_identity. La UI puede marcar visualmente a los anónimos.';

-- Backfill de filas existentes: los mensajes del Oráculo y los de usuarios con
-- user_id no son anónimos.
update public.biosphere_messages set is_anon = false
  where is_oracle = true or user_id is not null;

-- Trigger BEFORE INSERT: la fuente de verdad de la identidad es el servidor, no
-- el cliente. SECURITY DEFINER para poder leer profiles saltándose su RLS.
create or replace function public.enforce_biosphere_message_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h citext;
begin
  -- Mensajes del Oráculo (los publica el servidor con service_role): se respetan
  -- tal cual; no son anónimos.
  if new.is_oracle then
    new.is_anon := false;
    return new;
  end if;

  -- Usuario registrado: user_id lo garantiza la RLS de 0001 (= auth.uid()).
  -- SOBREESCRIBIMOS display_name con su handle: no se confía en el cliente.
  if new.user_id is not null then
    select handle into h from public.profiles where id = new.user_id;
    if h is not null then
      new.display_name := h::text;
      new.is_anon := false;
      return new;
    end if;
  end if;

  -- Anónimo: conserva su display_name libre, pero marcado como anónimo…
  new.is_anon := true;
  -- …y no puede hacerse pasar por un Oráculo (anti-suplantación barata).
  if new.display_name ~* '^\s*(paqo|cosmogenes|eme[ -]?y[ -]?uru|espinosito|nin|brangulio)\M' then
    new.display_name := 'Viajero anónimo';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_biosphere_message_identity on public.biosphere_messages;
create trigger trg_biosphere_message_identity
  before insert on public.biosphere_messages
  for each row execute function public.enforce_biosphere_message_identity();

-- =============================================================================
-- FIN 0003_hardening.sql
-- =============================================================================
