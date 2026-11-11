// Motor de traducción local: la API `Translator` integrada en Chrome (modelo
// en el propio equipo, gratuito y sin enviar texto a ningún servidor).
//
// Crear un traductor puede tardar (o no ser posible todavía) si el paquete de
// idioma no está descargado. Este motor nunca bloquea los subtítulos por eso:
// responde "loading" mientras el traductor se está creando (está al caer) o
// "not-ready" si no se ha podido crear, y sigue intentándolo en segundo plano.

const coded = (code, message) => Object.assign(new Error(message), { code });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createChromeEngine(
  api = globalThis.Translator,
  { waitMs = 1500, retryMs = 15000, loadingMs = 6000 } = {},
) {
  const entries = new Map();

  function start(entry, source, target) {
    entry.startedAt = Date.now();
    entry.pending = (async () => {
      try {
        const availability = await api.availability({ sourceLanguage: source, targetLanguage: target });
        if (availability === 'unavailable') {
          entry.unsupported = true;
          return;
        }
        entry.translator = await api.create({ sourceLanguage: source, targetLanguage: target });
      } catch {
        entry.retryAt = Date.now() + retryMs;
      } finally {
        entry.pending = null;
      }
    })();
  }

  return {
    /**
     * @param {{wait?: boolean}} [options]  wait=true: si el traductor se está
     *   creando, esperar a que termine (con un límite) en vez de fallar ya.
     */
    async translate(text, source, target, { wait = false } = {}) {
      if (!api) throw coded('unsupported', 'Este Chrome no incluye la API Translator');

      const key = `${source}>${target}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = { translator: null, pending: null, unsupported: false, retryAt: 0 };
        entries.set(key, entry);
      }

      if (!entry.translator && !entry.unsupported && !entry.pending && Date.now() >= entry.retryAt) {
        start(entry, source, target);
        // Solo espera (un poco) la llamada que lanza el intento.
        await Promise.race([entry.pending, sleep(waitMs)]);
      }

      if (wait && entry.pending) {
        const left = entry.startedAt + loadingMs - Date.now();
        if (left > 0) await Promise.race([entry.pending, sleep(left)]);
      }

      if (entry.unsupported) throw coded('unsupported', `Chrome no traduce de ${source} a ${target}`);
      if (!entry.translator) {
        // Si se está creando desde hace poco, es cuestión de un momento; si
        // lleva mucho (una descarga larga), cuenta como que aún no se puede.
        const loading = entry.pending && Date.now() - entry.startedAt < loadingMs;
        throw coded(loading ? 'loading' : 'not-ready', `El paquete de idioma ${source}→${target} aún no está listo`);
      }

      try {
        return { text: await entry.translator.translate(text) };
      } catch (err) {
        entry.translator = null;
        entry.retryAt = Date.now() + retryMs;
        throw coded('not-ready', err?.message ?? 'El traductor local falló');
      }
    },
  };
}
