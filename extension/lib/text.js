// Limpieza de lo que devuelve Whisper antes de traducirlo.

// Con silencio o música, Whisper tiende a "recordar" créditos de subtítulos
// de sus datos de entrenamiento. Nunca son habla real del vídeo.
const INVENTED_CREDITS = [
  /amara\.org/i,
  /subt[ií]tulos (realizados|creados|hechos) por/i,
  /sous-titres (réalisés|faits) par/i,
  /untertitel (der|von|im auftrag)/i,
  /sottotitoli (creati|e revisione)/i,
  /legendas pela comunidade/i,
  /subtitles by the/i,
  /napisy stworzone przez/i,
  /субтитры (сделал|создавал|подготовил)/i,
  /редактор субтитров/i,
  /字幕由.*提供/,
  /ご視聴ありがとうございました/,
];

const key = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** "gracias gracias gracias gracias…" → "gracias" (bucles de 4 o más repeticiones). */
function collapseLoops(text) {
  let words = text.split(' ');
  for (let n = 1; n <= 8; n++) {
    const keys = words.map(key);
    const out = [];
    let i = 0;
    while (i < words.length) {
      let reps = 1;
      for (;;) {
        const next = i + reps * n;
        if (next + n > words.length) break;
        let same = true;
        for (let k = 0; k < n && same; k++) same = keys[i + k] !== '' && keys[i + k] === keys[next + k];
        if (!same) break;
        reps++;
      }
      if (reps >= 4) {
        out.push(...words.slice(i, i + n));
        i += reps * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words.join(' ');
}

/**
 * ¿Es el texto un bucle sin sentido? Cuando Whisper se pierde (idioma
 * equivocado, ruido, música) repite una sílaba o un par de palabras hasta
 * agotar el espacio: «i wneud i wneud i wneud…», «ddododododododo».
 */
export function looksDegenerate(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return false;
  // La misma sílaba pegada muchas veces seguidas.
  if (/(\p{L}{1,4})\1{6,}/u.test(clean.replace(/\s+/g, ''))) return true;

  // Una, dos o tres palabras repetidas en cadena que son media transcripción.
  const words = clean.split(/\s+/).map(key);
  if (words.length < 6) return false;
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length) {
        let same = true;
        for (let k = 0; k < n && same; k++) same = words[i + k] !== '' && words[i + k] === words[i + reps * n + k];
        if (!same) break;
        reps++;
      }
      if (reps >= 4 && reps * n >= words.length / 2) return true;
    }
  }
  return false;
}

export function cleanTranscript(text) {
  let out = String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ') // [Music], (aplausos), *risas*
    .replace(/[♪♫♬🎵🎶]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return '';
  if (INVENTED_CREDITS.some((pattern) => pattern.test(out))) return '';
  if (looksDegenerate(out)) return '';
  return collapseLoops(out);
}
