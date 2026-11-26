// NOMBRES ALTERNOS de colonias (nov 2026): nombres con los que la gente, el
// INE o las constructoras conocen a una colonia que en el catálogo del INEGI
// se llama distinto. Solo sirven para el BUSCADOR: escribir el nombre alterno
// encuentra la colonia oficial (con una línea que explica por qué salió). No
// cambian la clave, el contorno ni la división de rutas.
//
// Dos fuentes:
//  1) nombresAlternosINE.json — GENERADO por scripts/comparar-colonias-ine.mjs
//     cruzando por ubicación la capa COLONIA del INE con el catálogo INEGI.
//     No editar a mano: se reescribe al correr el script.
//  2) MANUALES (abajo) — confirmados en campo. Agregar aquí SOLO nombres
//     confirmados, no listas sacadas de un chat de IA: varias de esas
//     resultaron ser colonias distintas, a veces a kilómetros de distancia.
//
//   k      = clave de la colonia en public/colonias_morelia.json
//   alias  = el otro nombre, como lo escribiría la gente
//   tipo   = 'alias'   → "también le dicen: …" (el mismo lugar, otro nombre)
//            'incluye' → "aquí queda: …" (un fraccionamiento o etapa más chica
//                        que el INEGI cuenta dentro de esta zona)

import DEL_INE from './nombresAlternosINE.json';

const MANUALES = [
  {
    k: '1605300010083', // Lomas de Morelia
    alias: 'Dr. Ignacio Chávez',
    tipo: 'alias',
    fuente:
      'Nombre original de la unidad habitacional. El INE la registra como ' +
      '"LOMAS DE MORELIA (DR IGNACIO CHAVEZ)" (BGD dic 2025).'
  }
];

// Los manuales van primero: si el INE trae el mismo nombre (sin acentos), se
// queda el escrito a mano.
export const NOMBRES_ALTERNOS = [...MANUALES, ...DEL_INE];
