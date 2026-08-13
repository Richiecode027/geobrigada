-- Esquema de GeoBrigada para Supabase.
-- Se pega completo en el SQL Editor del proyecto y se presiona "Run".
--
-- Es seguro correr el archivo ENTERO las veces que haga falta, aunque ya se
-- haya corrido antes: "create table/column if not exists" no rehace lo que
-- ya existe, y cada "create policy" trae su "drop policy if exists" arriba
-- (Postgres no tiene "create policy if not exists"). Nada de esto toca las
-- FILAS ya guardadas — solo define de nuevo las reglas de acceso, así que
-- no hay riesgo de perder información aunque se pegue por accidente el
-- archivo completo en vez de solo la parte nueva.

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

drop policy if exists "brigadistas suben reportes" on reportes;
create policy "brigadistas suben reportes"
  on reportes for insert to anon with check (true);

drop policy if exists "coordinador lee reportes" on reportes;
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

drop policy if exists "brigadistas reportan posicion" on posiciones;
create policy "brigadistas reportan posicion"
  on posiciones for insert to anon with check (true);

drop policy if exists "brigadistas actualizan su posicion" on posiciones;
create policy "brigadistas actualizan su posicion"
  on posiciones for update to anon using (true) with check (true);

drop policy if exists "coordinador ve posiciones" on posiciones;
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

drop policy if exists "lee cache calles" on calles_cache;
create policy "lee cache calles"
  on calles_cache for select to anon using (true);

drop policy if exists "guarda cache calles" on calles_cache;
create policy "guarda cache calles"
  on calles_cache for insert to anon with check (true);

drop policy if exists "refresca cache calles" on calles_cache;
create policy "refresca cache calles"
  on calles_cache for update to anon using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Actividades (jun 2026): cada brigada lleva etiqueta de actividad (Folletos,
-- Calendarios, Visita...) para separar visitas repetidas a la misma colonia.

alter table reportes add column if not exists actividad text;
alter table posiciones add column if not exists actividad text;

-- ---------------------------------------------------------------------------
-- Campaña y Brigada (jun 2026): la actividad pertenece a una campaña
-- (Presidencia, Diputación…) y la cubren varias brigadas que se reparten las
-- colonias. Estas columnas etiquetan cada reporte y posición.

alter table reportes add column if not exists campana text;
alter table reportes add column if not exists brigada text;
alter table posiciones add column if not exists campana text;
alter table posiciones add column if not exists brigada text;

-- ---------------------------------------------------------------------------
-- Rastro nativo (jul 2026): el GPS del APK sigue registrando aunque el
-- brigadista cierre la app a medio camino (@capgo/background-geolocation en
-- "modo de entrega nativa"). Esos puntos NO pasan por el JavaScript de la
-- app — los manda el celular directo a netlify/functions/gps-relay, que los
-- guarda aquí. Al reabrir, Brigadista.jsx lee lo que se acumuló desde el
-- último punto que ya tenía y rellena el trazo y el porcentaje.

create table if not exists rastro_nativo (
  id bigint generated always as identity primary key,
  ruta text not null,
  lat double precision,
  lng double precision,
  creado timestamptz not null default now()
);

create index if not exists rastro_nativo_ruta_creado
  on rastro_nativo (ruta, creado);

alter table rastro_nativo enable row level security;

drop policy if exists "el relay de gps guarda puntos" on rastro_nativo;
create policy "el relay de gps guarda puntos"
  on rastro_nativo for insert to anon with check (true);

drop policy if exists "el brigadista lee su rastro al reabrir" on rastro_nativo;
create policy "el brigadista lee su rastro al reabrir"
  on rastro_nativo for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Bardas (jul 2026): fase de pintar bardas con el nombre del candidato. Una
-- persona recorre la ciudad en carro marcando bardas viables (eso llega en un
-- Excel que se convierte a public/bardas.json con scripts/build-bardas.mjs);
-- luego los equipos van a esas ubicaciones a PEDIR PERMISO al dueño.
--
-- Esta tabla guarda el RESULTADO de cada visita. El catálogo de bardas vive en
-- el JSON (no cambia durante la jornada); aquí solo se registra a quién ya se
-- le preguntó y qué contestó, para que la app sepa cuáles siguen pendientes.

create table if not exists bardas_permisos (
  -- Una fila por barda: si se vuelve a visitar, se actualiza la misma.
  barda_id text primary key,
  permiso boolean,            -- true = dejó pintar, false = no quiso
  nombre text,                -- nombre del dueño / quien atendió
  telefono text,
  a_cambio text,              -- qué se ofreció (despensa, pintura, etc.)
  notas text,
  equipo text,                -- quién hizo la visita
  campana text,
  brigada text,
  lat double precision,       -- dónde estaba el equipo al registrar
  lng double precision,
  actualizado timestamptz not null default now()
);

alter table bardas_permisos enable row level security;

drop policy if exists "equipos registran permisos de barda" on bardas_permisos;
create policy "equipos registran permisos de barda"
  on bardas_permisos for insert to anon with check (true);

drop policy if exists "equipos corrigen el permiso de una barda" on bardas_permisos;
create policy "equipos corrigen el permiso de una barda"
  on bardas_permisos for update to anon using (true) with check (true);

drop policy if exists "todos ven que bardas ya se visitaron" on bardas_permisos;
create policy "todos ven que bardas ya se visitaron"
  on bardas_permisos for select to anon using (true);

-- Deshacer un registro equivocado (jul 2026): en campo es fácil tocar la barda
-- de arriba en vez de la de abajo, y sin esto esa barda quedaría marcada como
-- visitada para siempre — nadie iría a pedir permiso ahí. No se borra la fila
-- (la tabla no permite DELETE desde el teléfono, a propósito): se marca como
-- anulada y la app la vuelve a contar como pendiente, dejando el rastro de
-- quién la anuló.
alter table bardas_permisos add column if not exists anulado boolean not null default false;

-- ---------------------------------------------------------------------------
-- Bardas agregadas desde el celular (jul 2026): el catálogo (public/bardas.json)
-- sale del Excel y no cambia en la jornada, pero un equipo puede encontrar en
-- la calle una barda que nadie capturó. Esta tabla guarda esas altas: id lo
-- genera el celular (uuid), la ubicación es la del GPS al momento de agregarla
-- y la foto (opcional) se sube al bucket "bardas-fotos-nuevas".

create table if not exists bardas_nuevas (
  id text primary key,
  direccion text,
  colonia text,
  distrito text,
  lat double precision not null,
  lng double precision not null,
  foto text,           -- URL pública en el bucket "bardas-fotos-nuevas", o null
  equipo text,
  creado timestamptz not null default now()
);

alter table bardas_nuevas enable row level security;

drop policy if exists "cualquiera agrega una barda nueva" on bardas_nuevas;
create policy "cualquiera agrega una barda nueva"
  on bardas_nuevas for insert to anon with check (true);

drop policy if exists "todos ven las bardas nuevas" on bardas_nuevas;
create policy "todos ven las bardas nuevas"
  on bardas_nuevas for select to anon using (true);

-- Bucket para las fotos de esas bardas nuevas (público: la app las muestra
-- con una URL directa, igual que las fotos del catálogo).
insert into storage.buckets (id, name, public)
values ('bardas-fotos-nuevas', 'bardas-fotos-nuevas', true)
on conflict (id) do nothing;

drop policy if exists "cualquiera sube foto de barda nueva" on storage.objects;
create policy "cualquiera sube foto de barda nueva"
  on storage.objects for insert to anon
  with check (bucket_id = 'bardas-fotos-nuevas');

drop policy if exists "cualquiera ve fotos de bardas nuevas" on storage.objects;
create policy "cualquiera ve fotos de bardas nuevas"
  on storage.objects for select to anon
  using (bucket_id = 'bardas-fotos-nuevas');

-- ---------------------------------------------------------------------------
-- Reservas de bardas (jul 2026): si dos equipos arrancan su recorrido al
-- mismo tiempo y cerca uno del otro, sin esto calcularían la MISMA ruta (el
-- algoritmo es determinista y solo descuenta bardas ya visitadas). Al armar
-- su recorrido, cada equipo aparta esas bardas por unas horas; los demás las
-- ven ocupadas y su ruta se calcula con las que quedan libres. Vencen solas
-- (columna "vence") por si un equipo cierra la app sin avisar.

create table if not exists bardas_reservadas (
  barda_id text primary key,
  equipo text,
  vence timestamptz not null,
  creado timestamptz not null default now()
);

alter table bardas_reservadas enable row level security;

drop policy if exists "equipos apartan bardas al iniciar su ruta" on bardas_reservadas;
create policy "equipos apartan bardas al iniciar su ruta"
  on bardas_reservadas for insert to anon with check (true);

drop policy if exists "equipos renuevan o liberan su reserva" on bardas_reservadas;
create policy "equipos renuevan o liberan su reserva"
  on bardas_reservadas for update to anon using (true) with check (true);

drop policy if exists "todos ven que bardas estan apartadas" on bardas_reservadas;
create policy "todos ven que bardas estan apartadas"
  on bardas_reservadas for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Corregir y quitar bardas agregadas desde el celular (ago 2026): capturando
-- en la calle se cuela una dirección mal escrita, una foto que salió movida o
-- una barda repetida. Hacía falta poder editarlas y quitarlas.
--
-- Quitar NO borra la fila: la marca como borrada, igual que bardas_permisos
-- con `anulado`. Así queda el rastro de que existió y de que alguien la quitó,
-- que en campo vale más que ahorrarse un renglón.

alter table bardas_nuevas add column if not exists borrado boolean not null default false;

drop policy if exists "corregir o quitar una barda agregada" on bardas_nuevas;
create policy "corregir o quitar una barda agregada"
  on bardas_nuevas for update to anon using (true) with check (true);

-- Para poder reemplazar la foto de una barda ya guardada.
drop policy if exists "reemplazar foto de barda nueva" on storage.objects;
create policy "reemplazar foto de barda nueva"
  on storage.objects for update to anon
  using (bucket_id = 'bardas-fotos-nuevas')
  with check (bucket_id = 'bardas-fotos-nuevas');

-- ---------------------------------------------------------------------------
-- Más resultados de visita (jul 2026): "permiso sí/no" no alcanzaba. Ahora
-- cada visita guarda un ESTADO:
--   con_permiso  · el dueño dejó pintar
--   sin_permiso  · el dueño no quiso
--   visitado     · se fue, pero no había nadie a quién preguntarle. Sale de
--                  la ruta de HOY y vuelve a pendientes al día siguiente (la
--                  app lo decide comparando "actualizado" con la fecha de hoy).
--   no_habitado  · casa sola/abandonada: no hay a quién pedirle permiso, así
--                  que sale de pendientes para siempre.
-- La columna "permiso" se conserva (la usan el Excel de corte y los scripts):
-- queda en true/false para los dos primeros y en null para los otros dos.

alter table bardas_permisos add column if not exists estado text;

update bardas_permisos
   set estado = case when permiso then 'con_permiso' else 'sin_permiso' end
 where estado is null;

-- ---------------------------------------------------------------------------
-- "¿Es buena barda?" (ago 2026): para decidir por dónde empezar, piden poder
-- marcar qué bardas se ven mejor que otras. Es independiente de si ya se le
-- preguntó al dueño o no —una barda puede ser "buena" y seguir pendiente— así
-- que va en su propia tabla, aplicable a CUALQUIER barda (del Excel o
-- agregada desde la app), igual que bardas_reservadas.

create table if not exists bardas_calidad (
  barda_id text primary key,
  buena boolean not null,
  equipo text,
  actualizado timestamptz not null default now()
);

alter table bardas_calidad enable row level security;

drop policy if exists "marcar la calidad de una barda" on bardas_calidad;
create policy "marcar la calidad de una barda"
  on bardas_calidad for insert to anon with check (true);

drop policy if exists "corregir la calidad de una barda" on bardas_calidad;
create policy "corregir la calidad de una barda"
  on bardas_calidad for update to anon using (true) with check (true);

drop policy if exists "todos ven que bardas son buenas" on bardas_calidad;
create policy "todos ven que bardas son buenas"
  on bardas_calidad for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Varias fotos por barda (ago 2026): antes solo se guardaba una. Las nuevas
-- se agregan en este arreglo; `foto` se conserva para las ~110 que ya solo
-- traían una (se sigue leyendo como respaldo si "fotos" viene vacío).

alter table bardas_nuevas add column if not exists fotos jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Dispositivo que hizo cada cambio (ago 2026): un código al azar que cada
-- teléfono se inventa una sola vez y guarda en su navegador (src/lib/
-- dispositivo.js) — NO es un identificador de hardware, eso ningún navegador
-- lo deja leer. Sirve para, más adelante, poder agrupar varios cambios como
-- "hechos por el mismo teléfono" aunque no haya escrito su nombre de equipo
-- esa vez. Se agrega en las cuatro tablas donde el celular escribe algo.

alter table bardas_permisos   add column if not exists dispositivo text;
alter table bardas_nuevas     add column if not exists dispositivo text;
alter table bardas_calidad    add column if not exists dispositivo text;
alter table bardas_reservadas add column if not exists dispositivo text;

-- ---------------------------------------------------------------------------
-- Fecha del PRIMER registro de una barda (ago 2026): antes, cada vez que se
-- corregía el resultado de una visita, "actualizado" se movía a la hora de
-- la corrección — y el corte de Excel perdía el rastro de cuándo se visitó
-- de verdad la primera vez, que es lo que importa para llevar control de
-- qué bardas se visitan.
--
-- "primer_registro" se llena solo la PRIMERA vez que se guarda una barda; un
-- disparador (trigger) impide que se toque después, sin importar qué mande
-- el código del teléfono — así queda garantizado aunque cambie el código
-- cliente en el futuro. "actualizado" se sigue moviendo con cada edición,
-- para lo que ya se usaba (orden de lectura); el corte ahora lee de
-- "primer_registro", no de "actualizado".

alter table bardas_permisos add column if not exists primer_registro timestamptz;

-- A las filas que ya existían no les toca un "primer registro" real: se usa
-- su "actualizado" de hoy como mejor aproximación disponible, en vez de
-- dejarlas sin fecha en el corte. Solo toca filas que aún no lo tengan, así
-- que correr esto de nuevo no vuelve a pisar nada.
update bardas_permisos
   set primer_registro = actualizado
 where primer_registro is null;

create or replace function conservar_primer_registro()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' then
    new.primer_registro := old.primer_registro;
  else
    new.primer_registro := now();
  end if;
  return new;
end;
$$;

drop trigger if exists bardas_permisos_primer_registro on bardas_permisos;
create trigger bardas_permisos_primer_registro
  before insert or update on bardas_permisos
  for each row execute function conservar_primer_registro();
