-- =============================================================================
-- Phygitalia · o.Oraculos.app — Migración inicial (S3 Plataforma)
-- =============================================================================
-- Esquema de datos: perfiles, progreso, memoria de Oráculos y chat público.
-- Se aplica en el proyecto Supabase kfgpxbwuyksrwzxuggif.
--
-- Convenciones:
--   · RLS activo en TODAS las tablas de negocio.
--   · `auth.uid()` = usuario autenticado (incluye usuarios anónimos con sesión).
--   · El chat público se expone a `anon` (sin sesión) y `authenticated`.
--   · Los campos privados de perfil se leen sólo por la vista `public_profiles`,
--     que respeta los flags de visibilidad.
--   · `service_role` (sólo servidor) omite RLS: se usa para persistir memoria de
--     Oráculos y para borrar mensajes del chat público (moderación).
--
-- Idempotencia razonable: usa IF NOT EXISTS / CREATE OR REPLACE donde el motor
-- lo permite. Pensado para correrse UNA vez sobre una base limpia.
-- =============================================================================

-- Extensiones -----------------------------------------------------------------
create extension if not exists "citext";      -- handles case-insensitive únicos
create extension if not exists "pgcrypto";     -- gen_random_uuid()

-- =============================================================================
-- Helper genérico: updated_at
-- =============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- profiles
-- =============================================================================
create table if not exists public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  handle           citext not null unique,
  bio              text,
  website          text,
  social           jsonb not null default '{}'::jsonb,           -- {twitter, instagram, ...}
  avatar           jsonb not null default '{}'::jsonb,           -- {archetype, tint}
  birthdate        date,
  location         text,
  birthdate_public boolean not null default false,
  location_public  boolean not null default false,
  created_at       timestamptz not null default now()
);

comment on table  public.profiles is 'Perfil de usuario. Lectura pública sólo vía vista public_profiles.';
comment on column public.profiles.avatar is 'JSON {archetype: string, tint: string} — arquetipo Tripo3D + tinte de paleta.';

alter table public.profiles enable row level security;

-- El dueño ve y edita su fila completa. La lectura pública NO pasa por aquí:
-- pasa por la vista public_profiles (security definer) con los flags aplicados.
drop policy if exists "profiles_owner_select" on public.profiles;
create policy "profiles_owner_select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_owner_insert" on public.profiles;
create policy "profiles_owner_insert" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Vista pública: expone sólo campos públicos, y nace/ubicación sólo si su flag
-- está activo. Es SECURITY DEFINER (dueño = postgres) para poder leer todos los
-- perfiles saltándose la RLS de la tabla base, exponiendo únicamente lo seguro.
drop view if exists public.public_profiles;
create view public.public_profiles
with (security_invoker = false)
as
  select
    p.id,
    p.handle,
    p.bio,
    p.website,
    p.social,
    p.avatar,
    case when p.birthdate_public then p.birthdate else null end as birthdate,
    case when p.location_public  then p.location  else null end as location,
    p.created_at
  from public.profiles p;

comment on view public.public_profiles is 'Proyección pública de profiles respetando birthdate_public / location_public.';

-- =============================================================================
-- progress
-- =============================================================================
create table if not exists public.progress (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  unlocked_biospheres text[] not null default '{paqo}',
  found_oracles       text[] not null default '{}',
  updated_at          timestamptz not null default now()
);

comment on table public.progress is 'Progreso de juego por usuario: biósferas desbloqueadas y oráculos encontrados.';

alter table public.progress enable row level security;

drop policy if exists "progress_owner_all" on public.progress;
create policy "progress_owner_all" on public.progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_progress_updated_at on public.progress;
create trigger trg_progress_updated_at
  before update on public.progress
  for each row execute function public.set_updated_at();

-- =============================================================================
-- oracle_conversations  +  oracle_messages  (memoria privada 1:1)
-- =============================================================================
create table if not exists public.oracle_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  oracle_id  text not null,
  summary    text,                                   -- resumen rodante (cada 20 msgs)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.oracle_conversations is 'Conversación privada usuario↔Oráculo con memoria (summary rodante).';

create index if not exists idx_oracle_conversations_user
  on public.oracle_conversations (user_id, updated_at desc);
create index if not exists idx_oracle_conversations_user_oracle
  on public.oracle_conversations (user_id, oracle_id);

alter table public.oracle_conversations enable row level security;

drop policy if exists "oracle_conversations_owner_all" on public.oracle_conversations;
create policy "oracle_conversations_owner_all" on public.oracle_conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_oracle_conversations_updated_at on public.oracle_conversations;
create trigger trg_oracle_conversations_updated_at
  before update on public.oracle_conversations
  for each row execute function public.set_updated_at();

create table if not exists public.oracle_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.oracle_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'oracle')),
  content         text not null,
  created_at      timestamptz not null default now()
);

comment on table public.oracle_messages is 'Mensajes de una conversación privada. role ∈ (user, oracle).';

create index if not exists idx_oracle_messages_conversation
  on public.oracle_messages (conversation_id, created_at);

alter table public.oracle_messages enable row level security;

-- El acceso a mensajes se autoriza por ser dueño de la conversación padre.
drop policy if exists "oracle_messages_owner_select" on public.oracle_messages;
create policy "oracle_messages_owner_select" on public.oracle_messages
  for select using (
    exists (
      select 1 from public.oracle_conversations c
      where c.id = oracle_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "oracle_messages_owner_insert" on public.oracle_messages;
create policy "oracle_messages_owner_insert" on public.oracle_messages
  for insert with check (
    exists (
      select 1 from public.oracle_conversations c
      where c.id = oracle_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- Nota: la inserción real la hace el servidor con service_role (omite RLS); estas
-- políticas permiten además una futura lectura/escritura directa desde el cliente
-- autenticado sin abrir la puerta a terceros.

-- =============================================================================
-- biosphere_messages  (chat público persistente por biósfera)
-- =============================================================================
create table if not exists public.biosphere_messages (
  id            uuid primary key default gen_random_uuid(),
  biosphere_id  text not null,
  user_id       uuid references public.profiles (id) on delete set null,   -- null = anónimo
  display_name  text not null,
  content       text not null check (char_length(content) > 0 and char_length(content) <= 280),
  is_oracle     boolean not null default false,
  created_at    timestamptz not null default now()
);

comment on table public.biosphere_messages is 'Chat público persistente por biósfera. Lectura para todos (incl. anon).';

create index if not exists idx_biosphere_messages_channel
  on public.biosphere_messages (biosphere_id, created_at desc);

alter table public.biosphere_messages enable row level security;
-- REPLICA IDENTITY FULL: Realtime necesita la fila completa para payloads de
-- UPDATE/DELETE en la suscripción del canal.
alter table public.biosphere_messages replica identity full;

-- Lectura para todos: anon (sin sesión) y authenticated.
drop policy if exists "biosphere_messages_public_read" on public.biosphere_messages;
create policy "biosphere_messages_public_read" on public.biosphere_messages
  for select to anon, authenticated using (true);

-- Inserción: autenticado escribiendo como sí mismo, O anónimo (sin uid) siempre
-- que aporte display_name. Nunca se permite marcar is_oracle desde el cliente
-- (los mensajes del Oráculo los publica el servidor con service_role).
drop policy if exists "biosphere_messages_insert" on public.biosphere_messages;
create policy "biosphere_messages_insert" on public.biosphere_messages
  for insert to anon, authenticated
  with check (
    is_oracle = false
    and char_length(display_name) > 0
    and (
      (auth.uid() is not null and user_id = auth.uid())
      or (user_id is null)
    )
  );

-- Sin políticas de UPDATE/DELETE ⇒ denegado para anon/authenticated.
-- Sólo service_role (que omite RLS) puede borrar (moderación).

-- Habilita Realtime en el canal público.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'biosphere_messages'
  ) then
    alter publication supabase_realtime add table public.biosphere_messages;
  end if;
end
$$;

-- =============================================================================
-- Trigger: crear profile al registrarse (auth.users → profiles)
-- =============================================================================
-- Genera un handle inicial único derivado del email o del uuid. El usuario podrá
-- cambiarlo luego desde /usuario. Además crea la fila de progress con Paqo
-- desbloqueado por defecto.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_handle citext;
  candidate   citext;
  suffix      text;
begin
  -- Base: parte local del email, saneada; si no hay email (anónimo), 'viajero'.
  base_handle := lower(regexp_replace(
    coalesce(split_part(new.email, '@', 1), 'viajero'),
    '[^a-z0-9_]', '', 'g'
  ));
  if base_handle is null or length(base_handle) = 0 then
    base_handle := 'viajero';
  end if;

  -- Sufijo corto derivado del uuid para minimizar colisiones.
  suffix := substr(replace(new.id::text, '-', ''), 1, 6);
  candidate := base_handle || '-' || suffix;

  insert into public.profiles (id, handle)
  values (new.id, candidate)
  on conflict (id) do nothing;

  insert into public.progress (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- Grants (Supabase: roles anon / authenticated / service_role ya existen)
-- =============================================================================
-- RLS sigue mandando; estos grants sólo habilitan el verbo SQL a nivel de rol.
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update on public.profiles              to authenticated;
grant select                 on public.public_profiles       to anon, authenticated;
grant select, insert, update on public.progress              to authenticated;
grant select, insert, update, delete on public.oracle_conversations to authenticated;
grant select, insert, update, delete on public.oracle_messages      to authenticated;
grant select, insert           on public.biosphere_messages  to anon, authenticated;

-- service_role: acceso total (persistencia de memoria y moderación).
grant all on public.profiles, public.progress,
             public.oracle_conversations, public.oracle_messages,
             public.biosphere_messages
  to service_role;

-- =============================================================================
-- FIN 0001_init.sql
-- =============================================================================
