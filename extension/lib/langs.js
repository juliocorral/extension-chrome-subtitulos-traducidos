// Utilidades de códigos de idioma compartidas por el reconocedor y los traductores.

const ALIASES = {
  iw: 'he',
  jw: 'jv',
  nb: 'no',
  'zh-cn': 'zh',
  'zh-hans': 'zh',
  'zh-sg': 'zh',
  'zh-tw': 'zh-hant',
  'zh-hk': 'zh-hant',
  'zh-hant': 'zh-hant',
};

function normalize(code) {
  if (!code) return null;
  const lower = String(code).toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const base = lower.split('-')[0];
  return ALIASES[base] ?? base;
}

export function sameLanguage(a, b) {
  const na = normalize(a);
  return na !== null && na === normalize(b);
}

/** Código que entiende el endpoint de Google Translate. */
export function toGoogleCode(code) {
  if (!code || code === 'auto') return 'auto';
  const n = normalize(code);
  if (n === 'zh') return 'zh-CN';
  if (n === 'zh-hant') return 'zh-TW';
  if (n === 'he') return 'iw';
  return n;
}

/**
 * Decide el idioma del audio a partir de las probabilidades que da Whisper
 * (`ranked`: [[idioma, probabilidad], …] de mayor a menor). Una vez hay un
 * idioma en curso (`sticky`) solo se cambia con una detección clara sobre
 * audio suficiente: con fragmentos cortos Whisper se equivoca a menudo.
 */
export function chooseLanguage(ranked, { sticky = null, audioSeconds = 0 } = {}) {
  const [top, probability] = ranked[0];
  if (!sticky || top === sticky) return top;
  return audioSeconds >= 2 && probability >= 0.7 ? top : sticky;
}

/**
 * Probabilidad de cada idioma a partir de las puntuaciones que da Whisper
 * (`scores`: [[idioma, puntuación], …]), de mayor a menor. Con `allowed` solo
 * compiten esos idiomas: Whisper confunde con mucha seguridad el inglés con
 * acento, las risas o la música con idiomas minoritarios (maorí, galés…), y
 * la extensión solo ofrece una lista concreta.
 */
export function rankLanguages(scores, allowed = null) {
  const admitted = allowed ? scores.filter(([code]) => allowed.has(code)) : scores;
  const pool = admitted.length ? admitted : scores;
  const max = Math.max(...pool.map(([, score]) => score));
  const weights = pool.map(([code, score]) => [code, Math.exp(score - max)]);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  return weights.map(([code, weight]) => [code, weight / total]).sort((a, b) => b[1] - a[1]);
}

/**
 * Sigue el idioma del audio a lo largo de la sesión.
 *
 * Con risas, aplausos o música, Whisper "detecta" con mucha seguridad idiomas
 * que nadie está hablando, y si se le hiciera caso los subtítulos se llenarían
 * de palabras inventadas. Por eso hay dos fases. Al principio el idioma puede
 * corregirse enseguida (el primer segundo de audio engaña a menudo). Cuando se
 * ha confirmado un par de veces queda asentado, y entonces solo se cambia si
 * dos trozos completos seguidos, largos y claros, coinciden en otro idioma.
 */
export class LanguageTracker {
  constructor() {
    this.current = null; // idioma con el que se está reconociendo
    this.established = false;
    this.confirmations = 0;
    this.rival = null; // idioma que disputa el puesto al asentado
    this.rivalChunks = 0;
  }

  /**
   * @param {{lang: string, prob: number}} detected  Lo que Whisper cree oír en esta pasada.
   * @param {{audioSeconds: number, final: boolean}} pass  final: un trozo de voz completo.
   */
  observe({ lang, prob }, { audioSeconds, final }) {
    if (!lang) return;
    if (this.current === null) {
      this.current = lang;
      return;
    }
    const enoughAudio = audioSeconds >= 2;

    if (lang === this.current) {
      if (enoughAudio && ++this.confirmations >= 2) this.established = true;
      if (final) this.#forgetRival();
      return;
    }

    if (!this.established) {
      if (enoughAudio && prob >= 0.7) {
        this.current = lang;
        this.confirmations = 1;
      }
      return;
    }

    if (!final || audioSeconds < 3 || prob < 0.7) return;
    if (lang === this.rival) this.rivalChunks++;
    else {
      this.rival = lang;
      this.rivalChunks = 1;
    }
    if (this.rivalChunks >= 2) {
      this.current = lang;
      this.#forgetRival();
    }
  }

  /**
   * Lo reconocido no tiene sentido (un bucle): puede que el idioma asentado
   * esté mal. Se sigue con él, pero vuelve a poder corregirse enseguida.
   */
  doubt() {
    this.established = false;
    this.confirmations = 0;
    this.#forgetRival();
  }

  #forgetRival() {
    this.rival = null;
    this.rivalChunks = 0;
  }
}
