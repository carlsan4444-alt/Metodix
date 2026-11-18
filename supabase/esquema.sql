-- =====================================================================
-- Metodix · esquema de base de datos (Supabase / PostgreSQL)
--
-- Idea general:
--   · clubs     → cada club, con dos códigos de alta: uno para
--                 entrenadores y otro (secreto) para coordinación.
--   · miembros  → quién pertenece a qué club y con qué rol
--                 ('coord' = coordinación, 'entrenador').
--   · docs      → todos los datos de la plataforma (sesiones,
--                 plantillas, configuración...) guardados por "ruta",
--                 igual que funcionaba en la versión de Claude:
--                   config/...                  → lo leen todos los del club
--                   cuentas/<usuario>/...       → solo ese entrenador (y coordinación)
--                   solicitudes/<usuario>       → solo ese entrenador (y coordinación)
--                   privado/...                 → solo coordinación
--
-- Las reglas (Row Level Security) las aplica la propia base de datos:
-- aunque alguien manipule la web, no puede leer lo que no le toca.
-- =====================================================================

create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  codigo_entrenador text not null unique,
  codigo_coordinacion text not null unique,
  created_at timestamptz not null default now()
);
alter table public.clubs enable row level security;
-- Sin políticas: nadie puede leer los códigos desde la web.

create table if not exists public.miembros (
  user_id uuid primary key references auth.users on delete cascade,
  club_id uuid not null references public.clubs on delete cascade,
  nombre text not null default '',
  rol text not null check (rol in ('coord', 'entrenador')),
  created_at timestamptz not null default now()
);
alter table public.miembros enable row level security;

-- Funciones de ayuda (security definer para no entrar en bucle con las reglas)
create or replace function public.mi_club() returns uuid
language sql stable security definer set search_path = public as $$
  select club_id from miembros where user_id = auth.uid()
$$;

create or replace function public.soy_coord() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from miembros where user_id = auth.uid() and rol = 'coord')
$$;

drop policy if exists "ver miembros" on public.miembros;
create policy "ver miembros" on public.miembros for select to authenticated
  using (user_id = auth.uid() or (club_id = public.mi_club() and public.soy_coord()));

-- Darse de alta en un club con su código
create or replace function public.unirse_club(codigo text, nombre text)
returns json language plpgsql security definer set search_path = public as $$
declare c clubs; r text;
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  select * into c from clubs where codigo_entrenador = upper(trim(codigo));
  if found then
    r := 'entrenador';
  else
    select * into c from clubs where codigo_coordinacion = upper(trim(codigo));
    if found then r := 'coord'; else raise exception 'Código de club no válido'; end if;
  end if;
  insert into miembros (user_id, club_id, nombre, rol)
  values (auth.uid(), c.id, coalesce(trim(nombre), ''), r)
  on conflict (user_id) do update set
    club_id = excluded.club_id,
    rol = case when miembros.rol = 'coord' and miembros.club_id = excluded.club_id then 'coord' else excluded.rol end,
    nombre = case when excluded.nombre <> '' then excluded.nombre else miembros.nombre end;
  return json_build_object('club', c.nombre, 'rol', r);
end $$;

create or replace function public.mi_cuenta() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('club_id', m.club_id, 'club', c.nombre, 'rol', m.rol, 'nombre', m.nombre)
  from miembros m join clubs c on c.id = m.club_id
  where m.user_id = auth.uid()
$$;

create or replace function public.cambiar_nombre(n text) returns void
language sql security definer set search_path = public as $$
  update miembros set nombre = trim(n) where user_id = auth.uid()
$$;

-- Datos de la plataforma
create table if not exists public.docs (
  club_id uuid not null references public.clubs on delete cascade,
  path text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (club_id, path)
);
alter table public.docs enable row level security;

drop policy if exists "coordinacion todo" on public.docs;
create policy "coordinacion todo" on public.docs for all to authenticated
  using (club_id = public.mi_club() and public.soy_coord())
  with check (club_id = public.mi_club() and public.soy_coord());

drop policy if exists "leer configuracion" on public.docs;
create policy "leer configuracion" on public.docs for select to authenticated
  using (club_id = public.mi_club() and path like 'config/%');

drop policy if exists "lo mio" on public.docs;
create policy "lo mio" on public.docs for all to authenticated
  using (club_id = public.mi_club() and (path like 'cuentas/' || auth.uid()::text || '/%' or path = 'solicitudes/' || auth.uid()::text))
  with check (club_id = public.mi_club() and (path like 'cuentas/' || auth.uid()::text || '/%' or path = 'solicitudes/' || auth.uid()::text));

-- Cambios en tiempo real (lo que guarda un entrenador le aparece al momento a coordinación)
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
