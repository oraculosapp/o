-- =============================================================================
-- Phygitalia · o.Oraculos.app — Migración 0002: Notificaciones in-app (beta)
-- =============================================================================
-- Añade la tabla `notifications` (campanita del HUD) con RLS de dueño, Realtime,
-- y extiende `handle_new_user()` para sembrar la notificación de bienvenida de
-- Paqo al crearse cada usuario (anónimo o registrado).
--
-- Convenciones heredadas de 0001_init.sql:
--   · RLS activo; `auth.uid()` = usuario (incluye anónimos con sesión).
--   · El dueño LEE sus notificaciones y sólo puede marcar `read_at` (update de
--     columna, restringido por GRANT a nivel de columna — la RLS no filtra por
--     columna, pero el grant sí).
--   · La INSERCIÓN la hace el servidor: `handle_new_user()` (security definer,
--     omite RLS) para la bienvenida, y en el futuro `service_role` para el resto.
--     No hay política de INSERT para clientes ⇒ nadie puede fabricarse notifs.
--
-- Idempotencia razonable: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF
-- EXISTS. Segura de re-correr sobre una base que ya tenga 0001 aplicada.
-- =============================================================================

-- =============================================================================
-- notifications
-- =============================================================================
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       text not null default 'system',       -- 'welcome' | 'system' | ...
  title      text not null,
  body       text,
  link       text,                                  -- ruta interna opcional (ej. /usuario)
  read_at    timestamptz,                           -- null = no leída
  created_at timestamptz not null default now()
);

comment on table  public.notifications is 'Notificaciones in-app por usuario (campanita HUD). read_at null = no leída.';
comment on column public.notifications.type is 'Categoría: welcome, system, … (texto libre en beta).';
comment on column public.notifications.link is 'Ruta interna opcional a la que lleva la notificación.';

-- Índice para la consulta del panel: las del usuario, más recientes primero.
create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

-- REPLICA IDENTITY FULL: Realtime necesita la fila completa en los payloads de
-- UPDATE (marcar como leída) para que el cliente reconcilie por id.
alter table public.notifications replica identity full;

-- El dueño LEE sus notificaciones.
drop policy if exists "notifications_owner_select" on public.notifications;
create policy "notifications_owner_select" on public.notifications
  for select using (auth.uid() = user_id);

-- El dueño ACTUALIZA sus notificaciones (en la práctica sólo `read_at`, acotado
-- por el GRANT de columna de abajo). No puede reasignarlas a otro usuario.
drop policy if exists "notifications_owner_update" on public.notifications;
create policy "notifications_owner_update" on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Sin políticas de INSERT/DELETE ⇒ denegado para anon/authenticated. Sólo el
-- trigger security-definer y service_role (que omiten RLS) insertan/borran.

-- Habilita Realtime en la tabla (postgres_changes: INSERT nueva notif, UPDATE
-- al marcar leída).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;

-- =============================================================================
-- Grants (RLS sigue mandando; el grant de columna acota el UPDATE a read_at)
-- =============================================================================
grant select on public.notifications to authenticated;
-- Sólo se permite actualizar la columna read_at desde el cliente autenticado:
grant update (read_at) on public.notifications to authenticated;
-- service_role: acceso total (siembra e inserciones futuras desde servidor).
grant all on public.notifications to service_role;

-- =============================================================================
-- handle_new_user() extendido: + notificación de bienvenida de Paqo
-- =============================================================================
-- Redefine la función de 0001 (perfil + progress) añadiendo la siembra de la
-- notificación de bienvenida. Al ser SECURITY DEFINER corre como owner y omite
-- la RLS de notifications (que no tiene política de INSERT para clientes).
-- Se dispara con el mismo trigger `on_auth_user_created` ya creado en 0001.
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

  suffix := substr(replace(new.id::text, '-', ''), 1, 6);
  candidate := base_handle || '-' || suffix;

  insert into public.profiles (id, handle)
  values (new.id, candidate)
  on conflict (id) do nothing;

  insert into public.progress (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  -- Bienvenida de Paqo (una por usuario). El guard evita duplicar si el trigger
  -- llegara a re-ejecutarse para el mismo usuario.
  if not exists (
    select 1 from public.notifications
    where user_id = new.id and type = 'welcome'
  ) then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      new.id,
      'welcome',
      'Paqo te dio la bienvenida a Phygitalia',
      'El anfitrión de barro te reconoce. Completa tu perfil para que los Oráculos te recuerden.',
      '/usuario'
    );
  end if;

  return new;
end;
$$;

-- El trigger `on_auth_user_created` de 0001 ya apunta a esta función; al hacer
-- CREATE OR REPLACE toma efecto sin recrearlo. (Se recrea por seguridad.)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- FIN 0002_notifications.sql
-- =============================================================================
