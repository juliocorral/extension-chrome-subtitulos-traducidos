import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationService } from '../../extension/lib/translation-service.js';

/** Motor de pega: traduce anteponiendo su nombre, o falla con el código dado. */
function engine(name, { failWith = null } = {}) {
  const e = {
    calls: [],
    failWith,
    async translate(text, source, target, options) {
      e.calls.push({ text, source, target, ...options });
      if (e.failWith) throw Object.assign(new Error(e.failWith), { code: e.failWith });
      return { text: `[${name} ${source}>${target}] ${text}` };
    },
  };
  return e;
}

test('si el audio ya está en el idioma de destino no se traduce', async () => {
  const chrome = engine('chrome');
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'auto' });
  const result = await service.translate('Hola a todos', { source: 'es', target: 'es' });
  assert.deepEqual(result, { text: 'Hola a todos', engine: 'none' });
  assert.equal(chrome.calls.length + google.calls.length, 0);
});

test('en automático se prefiere el traductor local de Chrome', async () => {
  const chrome = engine('chrome');
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'auto' });
  const result = await service.translate('Hello', { source: 'en', target: 'es' });
  assert.deepEqual(result, { text: '[chrome en>es] Hello', engine: 'chrome' });
  assert.equal(google.calls.length, 0);
});

test('en automático, si Chrome no puede, traduce Google', async () => {
  const chrome = engine('chrome', { failWith: 'not-ready' });
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'auto' });
  const result = await service.translate('Hello', { source: 'en', target: 'es' });
  assert.equal(result.text, '[google en>es] Hello');
  assert.equal(result.engine, 'google');
  assert.equal(result.fallback, 'not-ready');
});

test('en automático vuelve a Chrome en cuanto está disponible', async () => {
  const chrome = engine('chrome', { failWith: 'not-ready' });
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'auto' });
  await service.translate('Hello', { source: 'en', target: 'es' });
  chrome.failWith = null;
  const result = await service.translate('Goodbye', { source: 'en', target: 'es' });
  assert.equal(result.engine, 'chrome');
});

test('el modo "google" no toca el traductor de Chrome', async () => {
  const chrome = engine('chrome');
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'google' });
  const result = await service.translate('Hello', { source: 'en', target: 'es' });
  assert.equal(result.engine, 'google');
  assert.equal(chrome.calls.length, 0);
});

test('el modo "chrome" no envía nada a Google aunque Chrome falle', async () => {
  const chrome = engine('chrome', { failWith: 'unsupported' });
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'chrome' });
  await assert.rejects(service.translate('Hello', { source: 'en', target: 'es' }), { code: 'unsupported' });
  assert.equal(google.calls.length, 0);
});

test('setMode cambia de motor en caliente', async () => {
  const chrome = engine('chrome');
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'chrome' });
  service.setMode('google');
  const result = await service.translate('Hello', { source: 'en', target: 'es' });
  assert.equal(result.engine, 'google');
});

test('una frase ya traducida no se vuelve a pedir', async () => {
  const chrome = engine('chrome');
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'google' });
  const first = await service.translate('Hello', { source: 'en', target: 'es' });
  const again = await service.translate('Hello', { source: 'en', target: 'es' });
  assert.deepEqual(again, first);
  assert.equal(google.calls.length, 1);
  // Otro idioma de destino es otra traducción.
  await service.translate('Hello', { source: 'en', target: 'fr' });
  assert.equal(google.calls.length, 2);
});

test('sin idioma de origen conocido se deja que Google lo detecte', async () => {
  const chrome = engine('chrome');
  const google = engine('google');
  const service = new TranslationService({ chrome, google, mode: 'auto' });
  const result = await service.translate('Bonjour', { source: null, target: 'es' });
  assert.equal(result.engine, 'google');
  assert.equal(chrome.calls.length, 0);
  assert.equal(google.calls[0].source, null);
});

test('a Google se le indica si la versión es provisional, para que pueda dosificarse', async () => {
  const google = engine('google');
  const service = new TranslationService({ chrome: engine('chrome'), google, mode: 'google' });
  await service.translate('Hello', { source: 'en', target: 'es', final: false });
  await service.translate('Hello there.', { source: 'en', target: 'es', final: true });
  await service.translate('Bye.', { source: 'en', target: 'es' });
  assert.deepEqual(google.calls.map((c) => c.final), [false, true, true]);
});

test('una versión provisional que Google se salta no se guarda como traducida', async () => {
  const google = engine('google', { failWith: 'skipped' });
  const service = new TranslationService({ chrome: engine('chrome'), google, mode: 'google' });
  await assert.rejects(service.translate('Hello', { source: 'en', target: 'es', final: false }), { code: 'skipped' });
  google.failWith = null;
  const result = await service.translate('Hello', { source: 'en', target: 'es', final: true });
  assert.equal(result.text, '[google en>es] Hello');
});
