// Motor de traducción en línea: endpoint gratuito (sin clave) de Google Translate.
// Se usa como respaldo cuando el traductor local de Chrome no está disponible.
//
// Es un servicio de cortesía: a quien le pregunta demasiado seguido le responde
// 429. Mientras se habla hay una versión nueva del subtítulo cada medio
// segundo, así que el motor se dosifica: nunca hay dos peticiones a la vez ni
// más de una por segundo; las versiones provisionales que no caben se
// descartan (code 'skipped') y las finales esperan su turno. Tras un 429 deja
// de preguntar un rato, cada vez más largo si se repite.
import { toGoogleCode } from './langs.js';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

const coded = (code, message) => Object.assign(new Error(message), { code });

export function parseGoogleResponse(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw coded('bad-response', 'Respuesta inesperada del traductor de Google');
  }
  const text = data[0].map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : '')).join('');
  return { text: text.trim(), detected: typeof data[2] === 'string' ? data[2] : null };
}

export function createGoogleEngine(
  fetchImpl = (...args) => globalThis.fetch(...args),
  {
    timeoutMs = 6000,
    minIntervalMs = 1000, // separación mínima entre peticiones
    backoffMs = 30_000, // pausa tras un 429; se dobla si se repite
    maxBackoffMs = 600_000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastStart = -Infinity;
  let waiting = 0; // peticiones finales en cola o en curso
  let busy = false;
  let turn = Promise.resolve(); // la petición anterior, para ir de una en una
  let blockedUntil = 0;
  let backoff = backoffMs;

  const saturated = () =>
    coded('rate-limited', 'El traductor de Google respondió 429: demasiadas peticiones. Se reintentará en un rato.');

  /** Google no quiere más peticiones: se le deja en paz un rato, más largo cada vez. */
  function backOff() {
    blockedUntil = now() + backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    return saturated();
  }

  async function request(text, source, target) {
    busy = true;
    lastStart = now();
    try {
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({
        client: 'gtx',
        sl: toGoogleCode(source),
        tl: toGoogleCode(target),
        dt: 't',
      }).toString();
      // El texto va en el cuerpo (POST), no en la URL.
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ q: text }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Cuando se cansa, Google responde 429 o redirige a su página de
      // «tráfico inusual» (HTML con estado 200): las dos cosas significan lo mismo.
      if (response.status === 429 || response.redirected) throw backOff();
      if (!response.ok) throw coded('http', `El traductor de Google respondió ${response.status}`);
      let data;
      try {
        data = await response.json();
      } catch {
        throw backOff();
      }
      backoff = backoffMs;
      return parseGoogleResponse(data);
    } finally {
      busy = false;
    }
  }

  return {
    /**
     * @param {{final?: boolean}} [options]  final=false: versión provisional,
     *   que puede descartarse si no toca preguntar todavía.
     */
    async translate(text, source, target, { final = true } = {}) {
      if (now() < blockedUntil) throw saturated();

      if (!final) {
        if (busy || waiting > 0 || now() - lastStart < minIntervalMs) {
          throw coded('skipped', 'Versión provisional descartada para no saturar el traductor en línea');
        }
        const run = request(text, source, target);
        turn = run.catch(() => {});
        return run;
      }

      waiting++;
      const run = turn.then(async () => {
        try {
          if (now() < blockedUntil) throw saturated();
          const wait = lastStart + minIntervalMs - now();
          if (wait > 0) await sleep(wait);
          return await request(text, source, target);
        } finally {
          waiting--;
        }
      });
      turn = run.catch(() => {});
      return run;
    },
  };
}
