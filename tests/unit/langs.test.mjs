import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameLanguage, toGoogleCode, chooseLanguage, rankLanguages, LanguageTracker } from '../../extension/lib/langs.js';

test('sameLanguage ignora la región y los alias antiguos', () => {
  assert.equal(sameLanguage('pt', 'pt-BR'), true);
  assert.equal(sameLanguage('he', 'iw'), true);
  assert.equal(sameLanguage('ES', 'es'), true);
  assert.equal(sameLanguage('zh', 'zh-CN'), true);
});

test('sameLanguage distingue idiomas distintos y chino simplificado de tradicional', () => {
  assert.equal(sameLanguage('en', 'es'), false);
  assert.equal(sameLanguage('zh', 'zh-Hant'), false);
  assert.equal(sameLanguage(null, 'es'), false);
});

test('toGoogleCode adapta los códigos que Google nombra distinto', () => {
  assert.equal(toGoogleCode('zh'), 'zh-CN');
  assert.equal(toGoogleCode('zh-Hant'), 'zh-TW');
  assert.equal(toGoogleCode('he'), 'iw');
  assert.equal(toGoogleCode('es'), 'es');
  assert.equal(toGoogleCode(null), 'auto');
  assert.equal(toGoogleCode('auto'), 'auto');
});

test('sin idioma previo se toma el más probable', () => {
  assert.equal(chooseLanguage([['fr', 0.55], ['es', 0.3]], { sticky: null, audioSeconds: 1 }), 'fr');
});

test('una detección dudosa no cambia el idioma en curso', () => {
  assert.equal(chooseLanguage([['pt', 0.5], ['es', 0.45]], { sticky: 'es', audioSeconds: 6 }), 'es');
});

test('un audio muy corto no cambia el idioma en curso aunque parezca seguro', () => {
  assert.equal(chooseLanguage([['cy', 0.95], ['en', 0.02]], { sticky: 'en', audioSeconds: 1.2 }), 'en');
});

test('una detección clara sobre audio suficiente sí cambia de idioma', () => {
  assert.equal(chooseLanguage([['fr', 0.97], ['en', 0.01]], { sticky: 'en', audioSeconds: 5 }), 'fr');
});

// ---------- idioma del audio a lo largo del vídeo ----------
//
// Con risas, aplausos o música, Whisper "detecta" con mucha seguridad idiomas
// que nadie habla (galés, hawaiano…). Una vez asentado el idioma del vídeo no
// se cambia por una detección suelta.

const pass = (seconds) => ({ audioSeconds: seconds, final: false });
const chunk = (seconds) => ({ audioSeconds: seconds, final: true });

test('sin idioma previo se adopta el primero que se detecta', () => {
  const tracker = new LanguageTracker();
  assert.equal(tracker.current, null);
  tracker.observe({ lang: 'en', prob: 0.6 }, pass(1));
  assert.equal(tracker.current, 'en');
  assert.equal(tracker.established, false);
});

test('el idioma se da por asentado al confirmarse en dos pasadas con audio suficiente', () => {
  const tracker = new LanguageTracker();
  tracker.observe({ lang: 'en', prob: 0.9 }, pass(1));
  tracker.observe({ lang: 'en', prob: 0.9 }, pass(2.5));
  assert.equal(tracker.established, false, 'una sola confirmación no basta');
  tracker.observe({ lang: 'en', prob: 0.9 }, pass(3));
  assert.equal(tracker.established, true);
});

test('antes de asentarse, una detección clara cambia el idioma al momento', () => {
  const tracker = new LanguageTracker();
  tracker.observe({ lang: 'pt', prob: 0.5 }, pass(0.8)); // arranque dudoso con muy poco audio
  tracker.observe({ lang: 'es', prob: 0.95 }, pass(2.5));
  assert.equal(tracker.current, 'es');
});

test('una vez asentado, una detección suelta de otro idioma no lo cambia', () => {
  const tracker = new LanguageTracker();
  for (const seconds of [1, 2.5, 3]) tracker.observe({ lang: 'en', prob: 0.95 }, pass(seconds));
  // Risas del público: Whisper dice "galés" con toda seguridad.
  tracker.observe({ lang: 'cy', prob: 0.97 }, chunk(5));
  assert.equal(tracker.current, 'en');
  tracker.observe({ lang: 'en', prob: 0.9 }, chunk(6));
  tracker.observe({ lang: 'cy', prob: 0.97 }, chunk(5));
  assert.equal(tracker.current, 'en', 'dos detecciones sueltas, con el idioma de siempre entre medias, tampoco');
});

test('una vez asentado, las pasadas provisionales no cuentan para cambiarlo', () => {
  const tracker = new LanguageTracker();
  for (const seconds of [1, 2.5, 3]) tracker.observe({ lang: 'en', prob: 0.95 }, pass(seconds));
  for (const seconds of [3, 4, 5, 6]) tracker.observe({ lang: 'cy', prob: 0.97 }, pass(seconds));
  assert.equal(tracker.current, 'en');
});

test('una vez asentado, cambia si dos trozos completos seguidos coinciden en otro idioma', () => {
  const tracker = new LanguageTracker();
  for (const seconds of [1, 2.5, 3]) tracker.observe({ lang: 'en', prob: 0.95 }, pass(seconds));
  tracker.observe({ lang: 'fr', prob: 0.9 }, chunk(5));
  assert.equal(tracker.current, 'en');
  tracker.observe({ lang: 'fr', prob: 0.9 }, chunk(4));
  assert.equal(tracker.current, 'fr');
});

test('un trozo corto o una detección dudosa no cuentan para cambiar un idioma asentado', () => {
  const tracker = new LanguageTracker();
  for (const seconds of [1, 2.5, 3]) tracker.observe({ lang: 'en', prob: 0.95 }, pass(seconds));
  tracker.observe({ lang: 'fr', prob: 0.9 }, chunk(1.5));
  tracker.observe({ lang: 'fr', prob: 0.5 }, chunk(5));
  tracker.observe({ lang: 'fr', prob: 0.9 }, chunk(5));
  assert.equal(tracker.current, 'en', 'solo ha habido un trozo válido en francés');
});

// ---------- la detección solo elige entre los idiomas que se ofrecen ----------
//
// Medido con un orador neozelandés: Whisper daba "maorí" con un 90 % de
// confianza en la mitad de las pasadas. Si solo puede elegir entre los idiomas
// que ofrece la extensión, ese falso positivo desaparece.

const round = (ranked) => ranked.map(([code, prob]) => [code, Math.round(prob * 100) / 100]);

test('rankLanguages convierte las puntuaciones de Whisper en probabilidades, de mayor a menor', () => {
  // exp(0)=1, exp(-ln 3)=1/3 → 0,75 y 0,25
  const ranked = rankLanguages([['fr', -Math.log(3)], ['en', 0]]);
  assert.deepEqual(round(ranked), [['en', 0.75], ['fr', 0.25]]);
});

test('un idioma que no se ofrece no puede ganar, por mucha puntuación que tenga', () => {
  const scores = [['mi', 5], ['en', 2], ['es', 0]];
  const ranked = rankLanguages(scores, new Set(['en', 'es', 'fr']));
  assert.equal(ranked[0][0], 'en');
  assert.ok(!ranked.some(([code]) => code === 'mi'));
});

test('las probabilidades se reparten solo entre los idiomas admitidos', () => {
  // Con «mi» fuera, entre «en» (e^2) y «es» (e^0): 0,88 y 0,12.
  const ranked = rankLanguages([['mi', 5], ['en', 2], ['es', 0]], new Set(['en', 'es']));
  assert.deepEqual(round(ranked), [['en', 0.88], ['es', 0.12]]);
});

test('si ninguno de los idiomas admitidos aparece, se usan todos', () => {
  const ranked = rankLanguages([['mi', 1], ['cy', 0]], new Set(['en']));
  assert.equal(ranked[0][0], 'mi');
});

test('una transcripción sin sentido hace dudar del idioma: vuelve a poder corregirse enseguida', () => {
  const tracker = new LanguageTracker();
  for (const seconds of [1, 2.5, 3]) tracker.observe({ lang: 'ko', prob: 0.95 }, pass(seconds));
  assert.equal(tracker.established, true);
  tracker.doubt();
  assert.equal(tracker.established, false);
  assert.equal(tracker.current, 'ko', 'se sigue con el mismo mientras no haya otro mejor');
  tracker.observe({ lang: 'en', prob: 0.9 }, pass(3));
  assert.equal(tracker.current, 'en');
});
