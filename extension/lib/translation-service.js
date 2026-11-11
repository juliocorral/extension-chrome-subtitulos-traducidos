// Elige con qué motor se traduce cada frase.
//   auto   → traductor local de Chrome; si no puede, Google (en línea).
//   chrome → solo local (nada sale del equipo).
//   google → solo Google.
import { sameLanguage } from './langs.js';

export class TranslationService {
  constructor({ chrome, google, mode = 'auto', cacheSize = 300 }) {
    this.chrome = chrome;
    this.google = google;
    this.mode = mode;
    this.cacheSize = cacheSize;
    this.cache = new Map();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.cache.clear();
  }

  /**
   * @param {{source: string|null, target: string, final?: boolean}} options
   *   final=false indica una versión provisional de la frase: el motor en
   *   línea puede saltársela (rechaza con code 'skipped') para no saturarse.
   */
  async translate(text, { source, target, final = true }) {
    if (source && sameLanguage(source, target)) return { text, engine: 'none' };

    const key = `${source}|${target}|${text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = await this.#run(text, source ?? null, target, final);
    this.cache.set(key, result);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  async #run(text, source, target, final) {
    const viaGoogle = async (extra = {}) => {
      const { text: translated } = await this.google.translate(text, source, target, { final });
      return { text: translated, engine: 'google', ...extra };
    };
    const viaChrome = async () => {
      // Una frase ya cerrada espera a que el traductor local termine de
      // cargarse; una provisional no (ya vendrá la siguiente).
      const { text: translated } = await this.chrome.translate(text, source, target, { wait: final });
      return { text: translated, engine: 'chrome' };
    };

    if (this.mode === 'google') return viaGoogle();
    // El traductor local necesita saber el idioma de origen.
    if (this.mode === 'auto' && !source) return viaGoogle();
    try {
      return await viaChrome();
    } catch (err) {
      // El traductor local se está cargando (un par de segundos al empezar):
      // una versión provisional puede esperar a la siguiente en vez de
      // traducirse por otro camino o salir sin traducir.
      if (err?.code === 'loading' && !final) {
        throw Object.assign(new Error('El traductor local se está cargando'), { code: 'skipped' });
      }
      if (this.mode === 'chrome') throw err;
      return viaGoogle({ fallback: err?.code ?? 'error' });
    }
  }
}
