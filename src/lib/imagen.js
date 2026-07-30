// Comprime una foto ANTES de subirla: la foto de una cámara de celular puede
// pesar varios MB, y en campo casi siempre hay datos móviles limitados.
// createImageBitmap con imageOrientation:'from-image' respeta la orientación
// EXIF (si no, las fotos tomadas en vertical saldrían acostadas).
export async function comprimirImagen(archivo, anchoMax = 1024, calidad = 0.72) {
  const bitmap = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
  const escala = Math.min(1, anchoMax / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * escala);
  canvas.height = Math.round(bitmap.height * escala);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo procesar la foto.'))),
      'image/jpeg',
      calidad
    );
  });
}
