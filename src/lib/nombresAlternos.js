// NOMBRES ALTERNOS de colonias (nov 2026): nombres con los que la gente, el
// INE o las constructoras conocen a una colonia que en el catálogo del INEGI
// se llama distinto. Solo sirven para el BUSCADOR: escribir el nombre alterno
// encuentra la colonia oficial (y se ve "también le dicen: …"). No cambian la
// clave, el contorno ni la división de rutas.
//
// Agregar aquí SOLO nombres confirmados (en campo o en una fuente oficial),
// no listas sacadas de un chat de IA: varias de esas resultaron ser colonias
// distintas, a veces a kilómetros de distancia.
//
//   k      = clave de la colonia en public/colonias_morelia.json
//   alias  = el otro nombre, como lo escribiría la gente
//   fuente = de dónde salió (para poder revisarlo después)

export const NOMBRES_ALTERNOS = [
  {
    k: '1605300010083', // Lomas de Morelia
    alias: 'Dr. Ignacio Chávez',
    fuente:
      'Nombre original de la unidad habitacional, según investigó el equipo (nov 2026). ' +
      'Cuadra con el catálogo: Lomas de Morelia colinda con Isaac Arriaga.'
  }
];
