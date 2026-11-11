import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleResponse, createGoogleEngine } from '../../extension/lib/google-translate.js';
import { createChromeEngine } from '../../extension/lib/chrome-translator.js';

// Respuesta real (recortada) de translate.googleapis.com para dos frases en→es.
const GOOGLE_FIXTURE = [
  [
    ['Hola mundo. ', 'Hello world. ', null, null, 10],
    ['¿Cómo estás?', 'How are you?', null, null, 3],
  ],
  null,
  'en',
  null,
  null,
  null,
  1,
  [],
  [['en'], null, [1], ['en']],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

// ---------- Google ----------

test('parseGoogleResponse une los tramos traducidos y da el idioma detectado', () => {
  assert.deepEqual(parseGoogleResponse(GOOGLE_FIXTURE), { text: 'Hola mundo. ¿Cómo estás?', detected: 'en' });
});

test('parseGoogleResponse rechaza respuestas con otra forma', () => {
  assert.throws(() => parseGoogleResponse({ error: 'nope' }));
  assert.throws(() => parseGoogleResponse([null, null, 'en']));
});

test('el motor de Google envía el texto y los idiomas pedidos y devuelve la traducción', async () => {
  const calls = [];
  const engine = createGoogleEngine(async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(GOOGLE_FIXTURE);
  });
  const result = await engine.translate('Hello world. How are you?', null, 'zh');
  assert.equal(result.text, 'Hola mundo. ¿Cómo estás?');
  assert.equal(result.detected, 'en');
  assert.equal(calls.length, 1);
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get('q'), 'Hello world. How are you?');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'zh-CN');
  assert.equal(url.searchParams.has('q'), false, 'el texto no debe viajar en la URL');
});

test('el motor de Google falla si el servidor responde con error', async () => {
  const engine = createGoogleEngine(async () => jsonResponse({}, 429));
  await assert.rejects(engine.translate('hi', 'en', 'es'), /429/);
});

// El servicio gratuito de Google corta (429) a quien le pregunta demasiado
// seguido, y mientras se habla hay una versión nueva cada medio segundo. El
// motor se dosifica: de las versiones provisionales solo traduce las que
// pueda sin agobiar; las finales, todas, de una en una.

/** Motor de Google con reloj y red de pega. `respond(n)` decide la respuesta n-ésima. */
function politeGoogle(respond = () => jsonResponse(GOOGLE_FIXTURE)) {
  const clock = { now: 0 };
  const calls = [];
  const engine = createGoogleEngine(
    async () => {
      calls.push(clock.now);
      return respond(calls.length);
    },
    { now: () => clock.now, sleep: async (ms) => void (clock.now += ms) },
  );
  return { engine, clock, calls };
}

const interim = { final: false };

test('una versión provisional se descarta si aún hay otra petición en curso', async () => {
  let release;
  const { engine, calls } = politeGoogle(() => new Promise((resolve) => (release = () => resolve(jsonResponse(GOOGLE_FIXTURE)))));
  const first = engine.translate('Hello', 'en', 'es', interim);
  await assert.rejects(engine.translate('Hello there', 'en', 'es', interim), { code: 'skipped' });
  assert.equal(calls.length, 1);
  release();
  assert.equal((await first).text, 'Hola mundo. ¿Cómo estás?');
});

test('una versión provisional se descarta si se preguntó hace menos de un segundo', async () => {
  const { engine, clock, calls } = politeGoogle();
  await engine.translate('Hello', 'en', 'es', interim);
  clock.now += 300;
  await assert.rejects(engine.translate('Hello there', 'en', 'es', interim), { code: 'skipped' });
  clock.now += 800;
  await engine.translate('Hello there my', 'en', 'es', interim);
  assert.deepEqual(calls, [0, 1100]);
});

test('las versiones finales no se descartan: se piden de una en una y espaciadas', async () => {
  const { engine, calls } = politeGoogle();
  const results = await Promise.all([
    engine.translate('One.', 'en', 'es'),
    engine.translate('Two.', 'en', 'es'),
    engine.translate('Three.', 'en', 'es'),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(calls, [0, 1000, 2000]);
});

test('tras un 429 deja de preguntar durante medio minuto y luego vuelve a intentarlo', async () => {
  const { engine, clock, calls } = politeGoogle((n) => (n === 1 ? jsonResponse({}, 429) : jsonResponse(GOOGLE_FIXTURE)));
  await assert.rejects(engine.translate('One.', 'en', 'es'), { code: 'rate-limited' });
  clock.now += 10_000;
  await assert.rejects(engine.translate('Two.', 'en', 'es'), { code: 'rate-limited' });
  await assert.rejects(engine.translate('Two', 'en', 'es', interim), { code: 'rate-limited' });
  assert.equal(calls.length, 1, 'durante la espera no debe salir ninguna petición');
  clock.now += 20_000;
  assert.equal((await engine.translate('Three.', 'en', 'es')).text, 'Hola mundo. ¿Cómo estás?');
  assert.equal(calls.length, 2);
});

test('si los 429 se repiten, la espera se alarga', async () => {
  const { engine, clock, calls } = politeGoogle((n) => (n <= 2 ? jsonResponse({}, 429) : jsonResponse(GOOGLE_FIXTURE)));
  await assert.rejects(engine.translate('One.', 'en', 'es'), { code: 'rate-limited' });
  clock.now += 30_000;
  await assert.rejects(engine.translate('Two.', 'en', 'es'), { code: 'rate-limited' });
  clock.now += 31_000;
  await assert.rejects(engine.translate('Three.', 'en', 'es'), { code: 'rate-limited' });
  assert.equal(calls.length, 2, 'la segunda espera debe ser más larga que la primera');
  clock.now += 30_000;
  await engine.translate('Four.', 'en', 'es');
  assert.equal(calls.length, 3);
});

test('una página de bloqueo en vez de la traducción también hace que deje de preguntar', async () => {
  // Visto de verdad: tras muchas peticiones Google ya no responde 429, sino que
  // redirige a su página de «tráfico inusual», que es HTML con estado 200.
  const blockPage = {
    ok: true,
    status: 200,
    redirected: true,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  };
  const { engine, clock, calls } = politeGoogle((n) => (n === 1 ? blockPage : jsonResponse(GOOGLE_FIXTURE)));
  await assert.rejects(engine.translate('One.', 'en', 'es'), { code: 'rate-limited' });
  clock.now += 5_000;
  await assert.rejects(engine.translate('Two.', 'en', 'es'), { code: 'rate-limited' });
  assert.equal(calls.length, 1, 'durante la espera no debe salir ninguna petición');
  clock.now += 26_000;
  assert.equal((await engine.translate('Three.', 'en', 'es')).text, 'Hola mundo. ¿Cómo estás?');
});

test('una respuesta que no es JSON se trata como bloqueo, no como traducción', async () => {
  const html = { ok: true, status: 200, redirected: false, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const { engine, calls } = politeGoogle(() => html);
  await assert.rejects(engine.translate('One.', 'en', 'es'), { code: 'rate-limited' });
  await assert.rejects(engine.translate('Two.', 'en', 'es'), { code: 'rate-limited' });
  assert.equal(calls.length, 1);
});

// ---------- Traductor integrado de Chrome ----------

/** Doble de la API `Translator` de Chrome. */
function fakeTranslatorApi({ availability = 'available', createDelay = 0, createError = null } = {}) {
  const api = {
    created: [],
    availabilityState: availability,
    createError,
    async availability() {
      return api.availabilityState;
    },
    async create({ sourceLanguage, targetLanguage }) {
      api.created.push(`${sourceLanguage}>${targetLanguage}`);
      if (createDelay) await sleep(createDelay);
      if (api.createError) throw api.createError;
      return { translate: async (text) => `${sourceLanguage}>${targetLanguage}:${text}` };
    },
  };
  return api;
}

test('el motor de Chrome traduce con un traductor del par de idiomas pedido', async () => {
  const engine = createChromeEngine(fakeTranslatorApi());
  assert.deepEqual(await engine.translate('hello', 'en', 'es'), { text: 'en>es:hello' });
});

test('el motor de Chrome reutiliza el traductor de cada par', async () => {
  const api = fakeTranslatorApi();
  const engine = createChromeEngine(api);
  await engine.translate('one', 'en', 'es');
  await engine.translate('two', 'en', 'es');
  await engine.translate('trois', 'fr', 'es');
  assert.deepEqual(api.created, ['en>es', 'fr>es']);
});

test('sin la API Translator el motor de Chrome se declara no compatible', async () => {
  const engine = createChromeEngine(undefined);
  await assert.rejects(engine.translate('hello', 'en', 'es'), { code: 'unsupported' });
});

test('un par de idiomas que Chrome no ofrece se declara no compatible', async () => {
  const engine = createChromeEngine(fakeTranslatorApi({ availability: 'unavailable' }));
  await assert.rejects(engine.translate('kaixo', 'eu', 'es'), { code: 'unsupported' });
});

test('mientras el paquete de idioma se descarga no bloquea, y funciona al terminar', async () => {
  const api = fakeTranslatorApi({ availability: 'downloadable', createDelay: 80 });
  const engine = createChromeEngine(api, { waitMs: 10 });
  // Se está creando (cargando o descargando): no es lo mismo que no poder.
  await assert.rejects(engine.translate('hello', 'en', 'es'), { code: 'loading' });
  await assert.rejects(engine.translate('hello', 'en', 'es'), { code: 'loading' });
  await sleep(120);
  assert.deepEqual(await engine.translate('hello', 'en', 'es'), { text: 'en>es:hello' });
  assert.deepEqual(api.created, ['en>es'], 'no debe lanzar descargas duplicadas');
});

test('una frase ya cerrada espera a que el traductor termine de cargarse', async () => {
  // Al empezar, la primera frase puede cerrarse antes de que el traductor
  // esté listo; es preferible esperarlo un momento a mostrarla sin traducir.
  const api = fakeTranslatorApi({ availability: 'available', createDelay: 80 });
  const engine = createChromeEngine(api, { waitMs: 10 });
  assert.deepEqual(await engine.translate('hello.', 'en', 'es', { wait: true }), { text: 'en>es:hello.' });
});

test('esa espera tiene un límite: si la carga se alarga, no se queda colgada', async () => {
  const api = fakeTranslatorApi({ availability: 'downloadable', createDelay: 500 });
  const engine = createChromeEngine(api, { waitMs: 10, loadingMs: 60 });
  await assert.rejects(engine.translate('hello.', 'en', 'es', { wait: true }), { code: 'not-ready' });
});

test('si crear el traductor falla, se reintenta más adelante', async () => {
  const api = fakeTranslatorApi({ availability: 'downloadable', createError: new Error('NotAllowedError') });
  const engine = createChromeEngine(api, { waitMs: 10, retryMs: 0 });
  await assert.rejects(engine.translate('hello', 'en', 'es'), { code: 'not-ready' });
  // El usuario descarga el paquete desde el popup: a partir de ahí ya se puede crear.
  api.createError = null;
  api.availabilityState = 'available';
  assert.deepEqual(await engine.translate('hello', 'en', 'es'), { text: 'en>es:hello' });
});
