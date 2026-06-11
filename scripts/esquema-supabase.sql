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
