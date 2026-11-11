// Convierte las sucesivas versiones de un subtítulo en un flujo de palabras
// que solo crece, como los subtítulos automáticos de YouTube.
//
// Mientras se habla, la traducción de la frase en curso se rehace entera cada
// medio segundo y sus últimas palabras cambian a menudo. Si se pintara tal
// cual, el texto bailaría. Aquí solo se da por buena una palabra cuando dos
// versiones seguidas coinciden en ella (y en todas las anteriores); lo que ya
// se ha mostrado no se retira nunca.

// Idiomas que no separan las palabras con espacios.
const NO_SPACES = new Set(['zh', 'ja', 'th', 'yue', 'lo', 'km', 'my']);
const SENTENCE_END = /[.!?…。！？]["'»”’)\]」』）]*$/;

const base = (lang) => String(lang ?? '').toLowerCase().split('-')[0];
// Para comparar palabras sin que estorben mayúsculas, puntuación ni tildes
// (el traductor devuelve a veces «como» y a la siguiente «cómo»).
const key = (word) =>
  word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

export function tokenize(text, lang) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (!NO_SPACES.has(base(lang)) || typeof Intl?.Segmenter !== 'function') return clean.split(/\s+/);

  const tokens = [];
  for (const { segment, isWordLike } of new Intl.Segmenter(lang, { granularity: 'word' }).segment(clean)) {
    if (!segment.trim()) continue;
    // La puntuación se queda pegada a la palabra anterior.
    if (isWordLike || tokens.length === 0) tokens.push(segment);
    else tokens[tokens.length - 1] += segment;
  }
  return tokens;
}

function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && key(a[i]) === key(b[i])) i++;
  return i;
}

// Palabras del final de cada versión provisional que no se muestran todavía:
// son las que más cambian al seguir llegando audio («de este» → «de esta
// conferencia»). Medido sobre 150 s de un discurso real: con dos, sobran un
// 36 % menos de palabras que con una, por solo 0,1 s más de retraso; con tres
// no mejora, y exigir tres versiones iguales duplica el retraso sin mejorar.
const HELD_BACK = 2;

const MATCH = 3; // lo que suma una palabra que coincide
const EDIT = 1; // lo que resta una palabra cambiada, sobrante o que falta

/**
 * Hasta dónde llega en `version` lo que ya recogen las palabras `shown`, y
 * cuántas de estas hacen falta para ello.
 *
 * El traductor puede haber cambiado palabras, puntuación o el número de
 * palabras entre una versión y otra; lo que se busca es el último punto en que
 * ambas siguen yendo a la par. Para encontrarlo se alinean las dos secuencias
 * desde el principio: cada palabra que coincide suma y cada palabra cambiada,
 * sobrante o que falta resta. Así una coincidencia aislada y lejana (un «de»
 * veinte palabras más allá) no compensa el salto, y se prefiere siempre la
 * coincidencia cercana. Lo que quede después de la última coincidencia no
 * cuenta: es texto nuevo, o texto que continúa en el subtítulo siguiente.
 */
function reach(shown, version) {
  const a = shown.map(key);
  const b = version.map(key);
  const width = b.length + 1;
  // score[i * width + j]: mejor puntuación alineando a[0..i) con b[0..j).
  const score = new Int32Array((a.length + 1) * width);
  for (let i = 1; i <= a.length; i++) score[i * width] = -i * EDIT;
  for (let j = 1; j <= b.length; j++) score[j] = -j * EDIT;

  let best = { score: 0, shown: 0, version: 0 };
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] !== '' && a[i - 1] === b[j - 1];
      const diagonal = score[(i - 1) * width + j - 1] + (same ? MATCH : -EDIT);
      const value = Math.max(diagonal, score[(i - 1) * width + j] - EDIT, score[i * width + j - 1] - EDIT);
      score[i * width + j] = value;
      // El punto de llegada tiene que ser una coincidencia; a igual puntuación,
      // la que deja más texto de la versión por mostrar.
      if (same && value === diagonal && (value > best.score || (value === best.score && j < best.version))) {
        best = { score: value, shown: i, version: j };
      }
    }
  }
  return { shown: best.shown, version: best.version };
}

export class WordStream {
  constructor() {
    this.#start(null);
  }

  /**
   * @param {{id: number, final: boolean, text: string, lang: string}} caption
   *   Una versión del subtítulo `id`; `lang` es el idioma de `text`.
   * @returns {{id: number, spaced: boolean, words: {text: string, sentenceStart: boolean}[]}}
   *   Las palabras nuevas que ya se pueden mostrar, en orden.
   */
  push({ id, final, text, lang }) {
    if (id !== this.id) this.#start(id);

    const version = tokenize(text, lang);
    const previous = this.previous;
    this.previous = version;
    const at = reach(this.shown, version);
    const kept = this.shown.length; // lo que había en pantalla antes de esta versión
    // De una versión provisional solo vale aquello en lo que coincide con la
    // anterior, y nunca sus últimas palabras: la frase puede seguir de otro modo.
    let until = final ? version.length : Math.min(commonPrefix(previous, version), version.length - HELD_BACK);
    // Tampoco se da por buena una palabra que cierra frase si es la última en
    // la que coinciden: hasta que no se confirma lo que viene detrás no se sabe
    // si ese punto era de verdad.
    if (!final) while (until > at.version && SENTENCE_END.test(version[until - 1])) until--;

    const words = [];
    for (let i = at.version; i < until; i++) {
      words.push({ text: version[i], sentenceStart: this.sentenceStart });
      this.sentenceStart = SENTENCE_END.test(version[i]);
      this.shown.push(version[i]);
    }

    // Un subtítulo puede cerrarse con menos texto del que tenían sus versiones
    // provisionales: la frase acababa antes y lo demás continúa en el subtítulo
    // siguiente. Este hereda lo que ya está en pantalla (para no repetirlo) y
    // la última versión (para seguir sin parón).
    if (final) {
      const before = reach(previous, version);
      const whole = version.length > 0;
      this.inherited = {
        shown: whole && at.version === version.length ? this.shown.slice(at.shown, kept) : [],
        previous: whole && before.version === version.length ? previous.slice(before.shown) : [],
      };
    }
    return { id, spaced: !NO_SPACES.has(base(lang)), words };
  }

  #start(id) {
    this.id = id;
    this.shown = this.inherited?.shown ?? []; // palabras de este subtítulo ya en pantalla
    this.previous = this.inherited?.previous ?? []; // versión anterior, para ver en qué coincide la nueva
    this.inherited = null;
    this.sentenceStart = this.shown.length === 0 || SENTENCE_END.test(this.shown.at(-1));
  }
}
