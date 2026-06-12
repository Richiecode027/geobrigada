-- Esquema de GeoBrigada para Supabase.
-- Se pega completo en el SQL Editor del proyecto y se presiona "Run" una vez.

create table if not exists reportes (
  id uuid primary key default gen_random_uuid(),
  creado timestamptz not null default now(),
  fecha text,
  colonia text,
  col text,
  poly text,
  equipo int,
  n_equipos int,
  km numeric,
  porcentaje int,
  entregados int,
  notas text,
  recorrido jsonb
);

-- Seguridad a nivel de fila: la "anon key" que viaja en el navegador
-- solo puede INSERTAR reportes nuevos y LEERLOS; no puede borrar ni
-- modificar nada. Borrar se hace desde el panel de Supabase.
alter table reportes enable row level security;

create policy "brigadistas suben reportes"
  on reportes for insert to anon with check (true);

create policy "coordinador lee reportes"
  on reportes for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Posiciones en vivo: una fila por equipo, se actualiza cada ~25 s mientras
-- el brigadista camina. La vista "En vivo" muestra las de la última media hora.

create table if not exists posiciones (
  id text primary key,
  colonia text,
  col text,
  equipo int,
  n_equipos int,
  lat double precision,
  lng double precision,
  pct int,
  actualizado timestamptz not null default now()
);

alter table posiciones enable row level security;

create policy "brigadistas reportan posicion"
  on posiciones for insert to anon with check (true);

create policy "brigadistas actualizan su posicion"
  on posiciones for update to anon using (true) with check (true);

create policy "coordinador ve posiciones"
  on posiciones for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Caché compartido de calles: el primer teléfono que descarga una colonia de
-- OpenStreetMap la guarda aquí; los demás la leen rápido aunque OSM esté caído.

create table if not exists calles_cache (
  clave text primary key,
  ways jsonb,
  actualizado timestamptz not null default now()
);

alter table calles_cache enable row level security;

create policy "lee cache calles"
  on calles_cache for select to anon using (true);

create policy "guarda cache calles"
  on calles_cache for insert to anon with check (true);

create policy "refresca cache calles"
  on calles_cache for update to anon using (true) with check (true);
