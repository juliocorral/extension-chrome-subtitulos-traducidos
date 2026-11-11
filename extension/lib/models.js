// Qué modelo de Whisper usar cuando el ajuste está en "automático".

// Gráficas que mueven con soltura el modelo "preciso" en tiempo real.
const POWERFUL_GPU = /apple|nvidia|amd|advanced micro devices/i;

/**
 * @param {string} choice  Ajuste del usuario: 'auto', 'tiny', 'base' o 'small'.
 * @param {{webgpu: boolean, vendor: string}} gpu  Lo que se sabe de la gráfica.
 * @returns {'tiny'|'base'|'small'}
 */
export function pickModel(choice, { webgpu, vendor }) {
  if (choice === 'tiny' || choice === 'base' || choice === 'small') return choice;
  return webgpu && POWERFUL_GPU.test(vendor ?? '') ? 'small' : 'base';
}
