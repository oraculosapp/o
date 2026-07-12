# S3 · Plataforma — Supabase + API del Oráculo

Guía operativa para **activar** los cimientos de datos e IA de Phygitalia. Todo
lo de código ya está listo; aquí están los pasos manuales (aplicar la migración,
poner las env vars y probar el endpoint).

Proyecto Supabase: **`kfgpxbwuyksrwzxuggif`** · URL `https://kfgpxbwuyksrwzxuggif.supabase.co`.

---

## 0. Qué entrega este equipo

| Pieza | Ruta |
|---|---|
| Esquema SQL (RLS + Realtime + trigger) | `supabase/migrations/0001_init.sql` |
| Cliente Supabase (browser + sesión anónima) | `apps/web/src/lib/supabase.ts` |
| Cliente service-role (servidor) | `apps/web/src/lib/supabase-admin.ts` |
| API del Oráculo (streaming GPT 5.4) | `apps/web/src/app/api/oracle/route.ts` (+ `lib/oracle/*`) |
| Contrato de system prompts | `apps/web/src/lib/oracle-prompts.d.ts` |
| Plantilla de env | `apps/web/.env.example` |
| Tests | `apps/web/src/**/__tests__/*.test.ts` (`pnpm --filter @phygitalia/web test`) |

---

## 1. Aplicar la migración (esquema + RLS + Realtime)

Dos caminos. **Elige uno.**

### Opción A — Editor SQL del dashboard (recomendado, sin instalar nada)

1. Entra a <https://supabase.com/dashboard/project/kfgpxbwuyksrwzxuggif/sql/new>.
2. Pega el contenido **completo** de `supabase/migrations/0001_init.sql` (está
   también al final de este documento, §5, listo para copiar).
3. Pulsa **Run**. Debe terminar sin errores (`Success. No rows returned`).
4. Verifica en **Table Editor** que existen: `profiles`, `progress`,
   `oracle_conversations`, `oracle_messages`, `biosphere_messages` y la vista
   `public_profiles`.
5. Verifica Realtime: **Database → Publications → `supabase_realtime`** debe
   listar `biosphere_messages`.
6. Habilita el login anónimo: **Authentication → Providers → Anonymous → Enable**
   (lo usa `ensureAnonSession()`).

### Opción B — Supabase CLI (con access token)

```bash
# 1. Instala la CLI (si no la tienes):  npm i -g supabase
# 2. Genera un Access Token en https://supabase.com/dashboard/account/tokens
export SUPABASE_ACCESS_TOKEN="sbp_xxx..."      # (PowerShell: $env:SUPABASE_ACCESS_TOKEN="sbp_xxx...")

# 3. Enlaza el proyecto (desde la raíz del repo D:\Oraculos\o):
supabase link --project-ref kfgpxbwuyksrwzxuggif

# 4. Aplica las migraciones de supabase/migrations/:
supabase db push
```

> La migración es idempotente en lo razonable (usa `if not exists` / `create or
> replace`), pero está pensada para correr **una vez** sobre una base limpia.

---

## 2. Variables de entorno

Copia `apps/web/.env.example` → `apps/web/.env.local` y rellena los valores.
Las mismas van en **Vercel** (Project → Settings → Environment Variables).

| Variable | Dónde se obtiene | Ámbito |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Settings → Data API → Project URL | Público (cliente) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Settings → API Keys → `anon` | Público (cliente) |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API Keys → `service_role` | **Secreto, sólo servidor** |
| `OPENAI_API_KEY` | Panel de OpenAI | **Secreto, sólo servidor** |
| `OPENAI_MODEL` *(opcional)* | — | Servidor (default `gpt-5.4`) |

⚠️ **Nunca** pongas `SUPABASE_SERVICE_ROLE_KEY` ni `OPENAI_API_KEY` con prefijo
`NEXT_PUBLIC_`. En Vercel, márcalas para los entornos Production/Preview según
convenga y NO las expongas al cliente.

Sin `OPENAI_API_KEY`, `/api/oracle` responde **503** con un mensaje claro (no
rompe el build ni el resto de la app).

---

## 3. Probar el endpoint con curl

El endpoint responde **SSE** (`text/event-stream`). Eventos: `meta`, `delta`
(uno por token), `done`, y `error` si falla a mitad.

### Chat público (anónimo, sin memoria)

```bash
curl -N -X POST http://localhost:3000/api/oracle \
  -H "content-type: application/json" \
  -H "x-session-id: demo-1" \
  -d '{
        "oracleId": "paqo",
        "mode": "public",
        "messages": [{ "role": "user", "content": "¿A qué oráculo debería ir?" }]
      }'
```

Salida esperada (troceada):

```
data: {"type":"meta","promptResolved":false}
data: {"type":"delta","text":"Hola"}
data: {"type":"delta","text":", viajero"}
...
data: {"type":"done"}
```

> `promptResolved:false` = se usó el fallback local de Paqo porque el Equipo
> Contenido aún no expone `getOracleSystemPrompt`. Pasará a `true` cuando lo haga
> (sin cambios en la Plataforma).

### Chat privado con memoria (usuario registrado)

Requiere un `access_token` de una sesión Supabase **no anónima** (magic link):

```bash
curl -N -X POST http://localhost:3000/api/oracle \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ACCESS_TOKEN_SUPABASE>" \
  -d '{
        "oracleId": "paqo",
        "mode": "private",
        "messages": [{ "role": "user", "content": "Acuérdate de mí, Paqo." }]
      }'
```

En privado + registrado, el servidor persiste el turno en `oracle_messages`,
mantiene un `summary` rodante (cada 20 mensajes) y devuelve `conversationId` en
el evento `meta` para continuar la conversación (reenvíalo como `conversationId`).

### Casos de error a comprobar

- Payload inválido / JSON roto → **400**.
- Falta `OPENAI_API_KEY` → **503**.
- Ráfaga (>20 req/min por IP+sesión) → **429** con `Retry-After`.

---

## 4. Notas de arquitectura y límites conocidos

- **RLS en todo.** Lectura pública sólo vía `public_profiles` (respeta los flags
  `birthdate_public` / `location_public`) y `biosphere_messages` (chat público).
- **Anti-inyección.** El mensaje del usuario **jamás** se concatena al system
  prompt; los roles entrantes se limitan a `user`/`oracle` y se rechaza `system`.
- **Rate-limit best-effort.** Es una LRU en memoria **por instancia**; en
  serverless (Vercel) no es una cuota global. Para una cuota dura habría que
  mover el contador a Postgres/Upstash (fuera del alcance de la beta).
- **Realtime.** `biosphere_messages` está en la publicación `supabase_realtime`
  con `replica identity full`; el cliente puede suscribirse por `biosphere_id`.
- **service_role.** La persistencia de memoria y el borrado de moderación usan la
  service key (omite RLS) sólo en el servidor.

---

## 5. SQL completo (copiar y pegar en el editor de Supabase)

> Fuente canónica: `supabase/migrations/0001_init.sql`. Si editas una, actualiza
> la otra.

```sql
-- =============================================================================
-- Phygitalia · o.Oraculos.app — Migración inicial (S3 Plataforma)
-- =============================================================================
-- Extensiones
create extension if not exists "citext";
create extension if not exists "pgcrypto";

-- Helper updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- profiles ---------------------------------------------------------------------
create table if not exists public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  handle           citext not null unique,
  bio              text,
  website          text,
  social           jsonb not null default '{}'::jsonb,
  avatar           jsonb not null default '{}'::jsonb,
  birthdate        date,
  location         text,
  birthdate_public boolean not null default false,
  location_public  boolean not null default false,
  created_at       timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles_owner_select" on public.profiles;
create policy "profiles_owner_select" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_owner_insert" on public.profiles;
create policy "profiles_owner_insert" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop view if exists public.public_profiles;
create view public.public_profiles with (security_invoker = false) as
  select p.id, p.handle, p.bio, p.website, p.social, p.avatar,
    case when p.birthdate_public then p.birthdate else null end as birthdate,
    case when p.location_public  then p.location  else null end as location,
    p.created_at
  from public.profiles p;

-- progress ---------------------------------------------------------------------
create table if not exists public.progress (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  unlocked_biospheres text[] not null default '{paqo}',
  found_oracles       text[] not null default '{}',
  updated_at          timestamptz not null default now()
);
alter table public.progress enable row level security;
drop policy if exists "progress_owner_all" on public.progress;
create policy "progress_owner_all" on public.progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop trigger if exists trg_progress_updated_at on public.progress;
create trigger trg_progress_updated_at before update on public.progress
  for each row execute function public.set_updated_at();

-- oracle_conversations + oracle_messages --------------------------------------
create table if not exists public.oracle_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  oracle_id  text not null,
  summary    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_oracle_conversations_user
  on public.oracle_conversations (user_id, updated_at desc);
create index if not exists idx_oracle_conversations_user_oracle
  on public.oracle_conversations (user_id, oracle_id);
alter table public.oracle_conversations enable row level security;
drop policy if exists "oracle_conversations_owner_all" on public.oracle_conversations;
create policy "oracle_conversations_owner_all" on public.oracle_conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop trigger if exists trg_oracle_conversations_updated_at on public.oracle_conversations;
create trigger trg_oracle_conversations_updated_at before update on public.oracle_conversations
  for each row execute function public.set_updated_at();

create table if not exists public.oracle_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.oracle_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'oracle')),
  content         text not null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_oracle_messages_conversation
  on public.oracle_messages (conversation_id, created_at);
alter table public.oracle_messages enable row level security;
drop policy if exists "oracle_messages_owner_select" on public.oracle_messages;
create policy "oracle_messages_owner_select" on public.oracle_messages
  for select using (exists (
    select 1 from public.oracle_conversations c
    where c.id = oracle_messages.conversation_id and c.user_id = auth.uid()));
drop policy if exists "oracle_messages_owner_insert" on public.oracle_messages;
create policy "oracle_messages_owner_insert" on public.oracle_messages
  for insert with check (exists (
    select 1 from public.oracle_conversations c
    where c.id = oracle_messages.conversation_id and c.user_id = auth.uid()));

-- biosphere_messages (chat público) -------------------------------------------
create table if not exists public.biosphere_messages (
  id            uuid primary key default gen_random_uuid(),
  biosphere_id  text not null,
  user_id       uuid references public.profiles (id) on delete set null,
  display_name  text not null,
  content       text not null check (char_length(content) > 0 and char_length(content) <= 280),
  is_oracle     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists idx_biosphere_messages_channel
  on public.biosphere_messages (biosphere_id, created_at desc);
alter table public.biosphere_messages enable row level security;
alter table public.biosphere_messages replica identity full;
drop policy if exists "biosphere_messages_public_read" on public.biosphere_messages;
create policy "biosphere_messages_public_read" on public.biosphere_messages
  for select to anon, authenticated using (true);
drop policy if exists "biosphere_messages_insert" on public.biosphere_messages;
create policy "biosphere_messages_insert" on public.biosphere_messages
  for insert to anon, authenticated with check (
    is_oracle = false and char_length(display_name) > 0
    and ((auth.uid() is not null and user_id = auth.uid()) or (user_id is null)));
do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'biosphere_messages') then
    alter publication supabase_realtime add table public.biosphere_messages;
  end if;
end $$;

-- Trigger: crear profile + progress al registrarse ----------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare base_handle citext; candidate citext; suffix text;
begin
  base_handle := lower(regexp_replace(
    coalesce(split_part(new.email, '@', 1), 'viajero'), '[^a-z0-9_]', '', 'g'));
  if base_handle is null or length(base_handle) = 0 then base_handle := 'viajero'; end if;
  suffix := substr(replace(new.id::text, '-', ''), 1, 6);
  candidate := base_handle || '-' || suffix;
  insert into public.profiles (id, handle) values (new.id, candidate)
    on conflict (id) do nothing;
  insert into public.progress (user_id) values (new.id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Grants ----------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update on public.profiles to authenticated;
grant select on public.public_profiles to anon, authenticated;
grant select, insert, update on public.progress to authenticated;
grant select, insert, update, delete on public.oracle_conversations to authenticated;
grant select, insert, update, delete on public.oracle_messages to authenticated;
grant select, insert on public.biosphere_messages to anon, authenticated;
grant all on public.profiles, public.progress, public.oracle_conversations,
             public.oracle_messages, public.biosphere_messages to service_role;
```

> Esta es una versión compacta del SQL (mismo efecto). La versión con todos los
> comentarios está en `supabase/migrations/0001_init.sql`; cualquiera de las dos
> produce el mismo esquema.

---

## 6. Migración 0002 — Notificaciones in-app (campanita del HUD)

Añade la tabla `notifications` y **extiende `handle_new_user()`** para sembrar la
notificación de bienvenida de Paqo. La usa la campanita del HUD (equipo Cuentas):
`components/notifications/Bell.tsx` + `lib/notifications.ts`.

### 6.1 Qué hace

| Pieza | Detalle |
|---|---|
| Tabla `notifications` | `id, user_id, type, title, body, link, read_at, created_at` |
| RLS | El dueño **lee** sus notificaciones y **sólo** puede actualizar `read_at` (grant de columna) |
| Inserción | Ningún cliente inserta; sólo el trigger `security definer` y `service_role` |
| Índice | `(user_id, created_at desc)` para el panel |
| Realtime | `notifications` en `supabase_realtime` con `replica identity full` (INSERT + UPDATE de `read_at`) |
| Bienvenida | `handle_new_user()` inserta `type='welcome'` "Paqo te dio la bienvenida a Phygitalia" (una por usuario) al crearse **cualquier** usuario, anónimo o registrado |

> **Nota de comportamiento:** el trigger `on_auth_user_created` corre en cada alta
> de `auth.users`, incluidos los **anónimos** (que se crean al entrar al mundo).
> Por eso todo viajero recibe la bienvenida de Paqo desde el primer instante; el
> guard `if not exists (… type='welcome')` evita duplicados. Al promover una
> sesión anónima a registrada (magic-link) **no** se crea una fila nueva en
> `auth.users`, así que no se duplica.

### 6.2 Qué debe hacer el humano

1. Abre <https://supabase.com/dashboard/project/kfgpxbwuyksrwzxuggif/sql/new>.
2. Pega el SQL completo de abajo (§6.3) — o el contenido de
   `supabase/migrations/0002_notifications.sql` — y pulsa **Run**. Debe terminar
   con `Success. No rows returned`. Es **idempotente-segura** (re-ejecutar no
   rompe: usa `if not exists` / `create or replace` / `drop policy if exists`).
3. Verifica en **Table Editor** que existe `notifications`.
4. Verifica Realtime: **Database → Publications → `supabase_realtime`** debe
   listar ahora también `notifications`.
5. (Ya cubierto por 0001) **Authentication → Providers → Anonymous → Enable**.

Sin esta migración la campanita **degrada con gracia**: no muestra badge y el
panel dice "Todo tranquilo por ahora" (los errores de tabla inexistente se
capturan en `lib/notifications.ts`). No rompe el build ni el resto de la app.

### 6.3 SQL completo (copiar y pegar)

> Fuente canónica: `supabase/migrations/0002_notifications.sql`.

```sql
-- notifications ---------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       text not null default 'system',
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
alter table public.notifications replica identity full;

drop policy if exists "notifications_owner_select" on public.notifications;
create policy "notifications_owner_select" on public.notifications
  for select using (auth.uid() = user_id);
drop policy if exists "notifications_owner_update" on public.notifications;
create policy "notifications_owner_update" on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Grants (el grant de columna acota el UPDATE del cliente a read_at) ----------
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- handle_new_user() extendido: + bienvenida de Paqo --------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare base_handle citext; candidate citext; suffix text;
begin
  base_handle := lower(regexp_replace(
    coalesce(split_part(new.email, '@', 1), 'viajero'), '[^a-z0-9_]', '', 'g'));
  if base_handle is null or length(base_handle) = 0 then base_handle := 'viajero'; end if;
  suffix := substr(replace(new.id::text, '-', ''), 1, 6);
  candidate := base_handle || '-' || suffix;
  insert into public.profiles (id, handle) values (new.id, candidate)
    on conflict (id) do nothing;
  insert into public.progress (user_id) values (new.id)
    on conflict (user_id) do nothing;
  if not exists (select 1 from public.notifications
                 where user_id = new.id and type = 'welcome') then
    insert into public.notifications (user_id, type, title, body, link)
    values (new.id, 'welcome',
      'Paqo te dio la bienvenida a Phygitalia',
      'El anfitrión de barro te reconoce. Completa tu perfil para que los Oráculos te recuerden.',
      '/usuario');
  end if;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

> La versión compacta de arriba produce el mismo efecto que
> `supabase/migrations/0002_notifications.sql` (que incluye todos los comentarios).

---

## 7. Migración 0003 — Endurecimiento de identidad (seguridad)

Correcciones de seguridad del magno ejercicio (M-1 + M-4). Endurece la identidad
en la base de datos, de modo que la BD deje de confiar en lo que manda el cliente:

### 7.1 Qué hace

- **(a) CHECK en `profiles`** (defensa en profundidad; la app ya valida):
  - `handle ~ '^[a-z0-9_-]{3,32}$'`
  - `char_length(bio) <= 280`, `char_length(location) <= 120`, `char_length(website) <= 200`
- **(b) Trigger `enforce_biosphere_message_identity` (BEFORE INSERT) en
  `biosphere_messages`**: para usuarios **registrados** (con `user_id`, que la RLS
  de 0001 garantiza `= auth.uid()`) SOBREESCRIBE `display_name` con el `handle` del
  perfil — el cliente ya no puede firmar con el nombre que quiera. Añade la columna
  `is_anon` (la fija el trigger) para que la UI distinga a los anónimos; los
  anónimos conservan su `display_name` libre.
- **(c) Anti-suplantación barata**: un anónimo cuyo `display_name` empiece por el
  nombre de un Oráculo (Paqo, Cosmogenes, Eme y Uru, Espinosito, Nin, Brangulio)
  se reescribe a `Viajero anónimo`.

### 7.2 Qué debe hacer el humano

1. Abre el **SQL Editor** del proyecto Supabase (`kfgpxbwuyksrwzxuggif`).
2. Pega el contenido **completo** de `supabase/migrations/0003_hardening.sql`
   (o el SQL de §7.3) y pulsa **Run**. Debe terminar sin error.
   - Es idempotente: si ya lo aplicaste, re-correrlo no rompe nada.
   - Si algún perfil existente violara un CHECK (no debería: los handles se generan
     en minúsculas), el `ALTER TABLE … ADD CONSTRAINT` fallaría — sanea esa fila y
     re-ejecuta.
3. Verifica en **Table editor → biosphere_messages** que aparece la columna
   `is_anon`, y en **Database → Triggers** que existe `trg_biosphere_message_identity`.

> **M-6 (captcha) — NO es SQL**: mitigar el registro/anon-abuse con captcha se
> configura en el **dashboard** de Supabase (Authentication → Attack Protection /
> CAPTCHA, proveedor hCaptcha/Turnstile). No lo cubre esta migración.

Sin esta migración la plataforma **sigue funcionando** (la app valida en cliente y
servidor), pero se pierde la red de seguridad de la BD y el `is_anon` que la UI usa
para marcar anónimos degradará a "sin bandera".

### 7.3 SQL completo (copiar y pegar)

> Fuente canónica: `supabase/migrations/0003_hardening.sql` (incluye todos los
> comentarios). Pega ese archivo tal cual; el bloque de abajo es la referencia rápida.

```sql
-- (a) CHECK de forma/longitud en profiles (idempotente)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_handle_format') then
    alter table public.profiles add constraint profiles_handle_format
      check (handle ~ '^[a-z0-9_-]{3,32}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_bio_len') then
    alter table public.profiles add constraint profiles_bio_len check (char_length(bio) <= 280);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_location_len') then
    alter table public.profiles add constraint profiles_location_len check (char_length(location) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_website_len') then
    alter table public.profiles add constraint profiles_website_len check (char_length(website) <= 200);
  end if;
end$$;

-- (b+c) is_anon + trigger de identidad en biosphere_messages
alter table public.biosphere_messages add column if not exists is_anon boolean not null default true;
update public.biosphere_messages set is_anon = false where is_oracle = true or user_id is not null;

create or replace function public.enforce_biosphere_message_identity()
returns trigger language plpgsql security definer set search_path = public as $$
declare h citext;
begin
  if new.is_oracle then new.is_anon := false; return new; end if;
  if new.user_id is not null then
    select handle into h from public.profiles where id = new.user_id;
    if h is not null then new.display_name := h::text; new.is_anon := false; return new; end if;
  end if;
  new.is_anon := true;
  if new.display_name ~* '^\s*(paqo|cosmogenes|eme[ -]?y[ -]?uru|espinosito|nin|brangulio)\M' then
    new.display_name := 'Viajero anónimo';
  end if;
  return new;
end;$$;

drop trigger if exists trg_biosphere_message_identity on public.biosphere_messages;
create trigger trg_biosphere_message_identity
  before insert on public.biosphere_messages
  for each row execute function public.enforce_biosphere_message_identity();
```
