import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionPipeline } from '../../extension/lib/pipeline.js';
import { UtteranceSegmenter } from '../../extension/lib/segmenter.js';

const RATE = 16000;

function frames(ms, amp) {
  const out = [];
  for (let f = 0; f < ms / 100; f++) {
    const frame = new Float32Array(1600);
    if (amp > 0) for (let i = 0; i < 1600; i++) frame[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
    out.push(frame);
  }
  return out;
}

/**
 * Monta el flujo con un reconocedor y un traductor de pega.
 * `heard` decide qué "oye" el reconocedor en cada pasada.
 */
function setup({ heard = () => ({ text: 'Hello world.', lang: 'en' }), settings = {}, translate, options } = {}) {
  const captions = [];
  const clock = { now: 0 };
  const asrCalls = [];
  const translateCalls = [];
  const current = { sourceLang: 'auto', targetLang: 'es', ...settings };
  const pipeline = new CaptionPipeline({
    segmenter: new UtteranceSegmenter(),
    settings: () => current,
    transcribe: async (audio, opts) => {
      asrCalls.push({ seconds: audio.length / RATE, ...opts });
      return heard(audio, opts, asrCalls.length);
    },
    translate:
      translate ??
      (async (text, opts) => {
        translateCalls.push({ text, ...opts });
        return { text: `ES(${text})`, engine: 'chrome' };
      }),
    emit: (caption) => captions.push(caption),
    now: () => clock.now,
    options,
  });
  const feed = (...groups) => {
    for (const g of groups) for (const f of g) pipeline.pushFrame(f);
  };
  // Las traducciones van en paralelo al reconocimiento: tras agotar el
  // trabajo pendiente se deja que terminen las que estén en curso.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const drain = async () => {
    while (await pipeline.step());
    await settle();
  };
  /** Deja pasar tiempo de reloj (sin audio nuevo) y procesa lo pendiente. */
  const wait = async (ms) => {
    clock.now += ms;
    await drain();
  };
  // Una frase dicha de un tirón y seguida de silencio suficiente para cerrarla.
  const say = async (speechMs = 1500) => {
    feed(frames(speechMs, 0.3), frames(1000, 0));
    await drain();
  };
  return { pipeline, captions, asrCalls, translateCalls, current, feed, drain, wait, say };
}

test('una frase terminada sale como subtítulo final traducido', async () => {
  const t = setup();
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  assert.equal(t.captions.length, 1);
  const [c] = t.captions;
  assert.equal(c.final, true);
  assert.equal(c.text, 'ES(Hello world.)');
  assert.equal(c.original, 'Hello world.');
  assert.equal(c.lang, 'en');
  assert.equal(c.engine, 'chrome');
});

test('mientras se habla salen subtítulos provisionales de la misma frase', async () => {
  const t = setup({ heard: (_a, _o, n) => ({ text: n === 1 ? 'hello' : 'Hello world.', lang: 'en' }) });
  t.feed(frames(1500, 0.3));
  await t.drain();
  assert.equal(t.captions.length, 1);
  assert.equal(t.captions[0].final, false);
  assert.equal(t.captions[0].text, 'ES(hello)');

  t.feed(frames(500, 0.3), frames(1000, 0));
  await t.drain();
  const last = t.captions.at(-1);
  assert.equal(last.final, true);
  assert.equal(last.text, 'ES(Hello world.)');
  assert.equal(last.id, t.captions[0].id, 'el final debe sustituir al provisional de la misma frase');
  assert.ok(last.rev > t.captions[0].rev);
});

test('no se repite el reconocimiento si la frase apenas ha crecido', async () => {
  const t = setup();
  t.feed(frames(1500, 0.3));
  await t.drain();
  assert.equal(t.asrCalls.length, 1);
  t.feed(frames(200, 0.3));
  await t.drain();
  assert.equal(t.asrCalls.length, 1, 'con 200 ms más no merece otra pasada');
  t.feed(frames(400, 0.3));
  await t.drain();
  assert.equal(t.asrCalls.length, 2);
});

test('una frase demasiado corta todavía no genera subtítulo provisional', async () => {
  const t = setup();
  t.feed(frames(500, 0.3));
  await t.drain();
  assert.equal(t.asrCalls.length, 0);
});

test('si una pasada nueva oye lo mismo, la versión se vuelve a emitir: confirma que el texto es estable', async () => {
  // Quien pinta los subtítulos solo da por buena una palabra cuando dos
  // versiones seguidas coinciden; si las repetidas se callaran, el final de
  // la frase se quedaría esperando durante toda una pausa del orador.
  const t = setup({ heard: () => ({ text: 'my one night out', lang: 'en' }) });
  t.feed(frames(1500, 0.3));
  await t.drain();
  t.feed(frames(600, 0.3));
  await t.drain();
  assert.equal(t.asrCalls.length, 2);
  assert.deepEqual(t.captions.map((c) => [c.text, c.final]), [
    ['ES(my one night out)', false],
    ['ES(my one night out)', false],
  ]);
  assert.equal(t.captions[1].id, t.captions[0].id);
  assert.ok(t.captions[1].rev > t.captions[0].rev);
});

test('lo que no es habla ([Music]) no genera subtítulos', async () => {
  const t = setup({ heard: () => ({ text: ' [Music]', lang: 'en' }) });
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  assert.deepEqual(t.captions, []);
  assert.equal(t.translateCalls.length, 0);
});

test('si la frase final resulta vacía se retira el provisional que se mostró', async () => {
  const t = setup({ heard: (_a, _o, n) => ({ text: n === 1 ? 'uh' : '', lang: 'en' }) });
  t.feed(frames(1500, 0.3));
  await t.drain();
  t.feed(frames(1000, 0));
  await t.drain();
  assert.equal(t.captions.length, 2);
  assert.deepEqual(
    { id: t.captions[1].id, final: t.captions[1].final, text: t.captions[1].text },
    { id: t.captions[0].id, final: true, text: '' },
  );
});

test('con idioma de audio automático se propone al reconocedor el último detectado', async () => {
  const t = setup({ heard: () => ({ text: 'Bonjour.', lang: 'fr' }) });
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  assert.equal(t.asrCalls[0].language, null);
  assert.equal(t.asrCalls[0].sticky, null);
  assert.equal(t.asrCalls.at(-1).language, null);
  assert.equal(t.asrCalls.at(-1).sticky, 'fr');
  assert.equal(t.translateCalls[0].text, 'Bonjour.');
  assert.equal(t.translateCalls[0].source, 'fr');
  assert.equal(t.translateCalls[0].target, 'es');
});

test('con idioma de audio fijo se usa ese idioma para reconocer y traducir', async () => {
  const t = setup({ settings: { sourceLang: 'de', targetLang: 'en' }, heard: () => ({ text: 'Guten Tag.', lang: 'de' }) });
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  assert.equal(t.asrCalls[0].language, 'de');
  assert.deepEqual(t.translateCalls[0], { text: 'Guten Tag.', source: 'de', target: 'en', final: true });
});

test('si la traducción falla se muestra el texto original en vez de nada', async () => {
  const t = setup({
    translate: async () => {
      throw Object.assign(new Error('sin red'), { code: 'network' });
    },
  });
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  assert.equal(t.captions.length, 1);
  assert.equal(t.captions[0].text, 'Hello world.');
  assert.equal(t.captions[0].engine, 'error');
  assert.equal(t.captions[0].error, 'sin red');
});

test('si el reconocimiento se retrasa se saltan las frases más antiguas', async () => {
  const t = setup({ options: { maxBacklog: 2 } });
  for (let i = 0; i < 4; i++) t.feed(frames(1000, 0.3), frames(1000, 0));
  await t.drain();
  const finals = t.captions.filter((c) => c.final);
  assert.equal(finals.length, 2, 'solo deben procesarse las dos frases más recientes');
  assert.equal(t.asrCalls.length, 2);
});

test('el cambio de idioma de destino se aplica a la siguiente frase', async () => {
  const t = setup();
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  t.current.targetLang = 'fr';
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  assert.equal(t.translateCalls[0].target, 'es');
  assert.equal(t.translateCalls.at(-1).target, 'fr');
});

// ---------- traducir por frases, no por trozos de audio ----------

test('una frase que el audio corta en dos trozos se traduce entera', async () => {
  const texts = ['We are going to talk about how black', 'holes are formed.'];
  const t = setup({ heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }), options: { minInterimMs: 60_000 } });
  await t.say();
  // El primer trozo no acaba la frase: se muestra, pero como provisional.
  assert.equal(t.captions.length, 1);
  assert.equal(t.captions[0].final, false);
  assert.equal(t.captions[0].text, 'ES(We are going to talk about how black)');

  await t.say();
  const last = t.captions.at(-1);
  assert.equal(last.final, true);
  assert.equal(last.text, 'ES(We are going to talk about how black holes are formed.)');
  assert.equal(last.id, t.captions[0].id, 'debe sustituir al provisional, no añadirse detrás');
});

test('mientras se habla, el provisional incluye el principio de frase que quedó pendiente', async () => {
  const texts = ['The people who', 'live here', 'live here are happy.'];
  const t = setup({ heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }) });
  // Trozo 1 completo (sin provisionales intermedios: se alimenta de golpe).
  t.feed(frames(1500, 0.3), frames(1000, 0));
  await t.drain();
  // Trozo 2 a medias.
  t.feed(frames(1500, 0.3));
  await t.drain();
  assert.equal(t.captions.at(-1).text, 'ES(The people who live here)');
  assert.equal(t.captions.at(-1).final, false);
});

test('lo que queda tras el último punto abre el subtítulo siguiente', async () => {
  const t = setup({ heard: () => ({ text: 'It is late. And tomorrow', lang: 'en' }), options: { minInterimMs: 60_000 } });
  await t.say();
  assert.equal(t.captions.length, 2);
  const [done, pending] = t.captions;
  assert.deepEqual({ final: done.final, text: done.text }, { final: true, text: 'ES(It is late.)' });
  assert.deepEqual({ final: pending.final, text: pending.text }, { final: false, text: 'ES(And tomorrow)' });
  assert.notEqual(pending.id, done.id);
});

test('si nadie sigue hablando, lo pendiente se da por terminado enseguida', async () => {
  // El orador ya había hecho la pausa que cerró el trozo de audio: no se
  // espera mucho más para escribir la última palabra.
  const t = setup({ heard: () => ({ text: 'And tomorrow', lang: 'en' }), options: { minInterimMs: 60_000 } });
  await t.say();
  assert.equal(t.captions.at(-1).final, false);
  await t.wait(900);
  assert.equal(t.captions.at(-1).final, false, 'aún es pronto para cerrarla');
  await t.wait(400);
  const last = t.captions.at(-1);
  assert.deepEqual({ final: last.final, text: last.text }, { final: true, text: 'ES(And tomorrow)' });
  assert.equal(last.id, t.captions[0].id);

  // Lo siguiente que se diga ya es otra frase: no arrastra la anterior.
  await t.say();
  assert.equal(t.translateCalls.at(-1).text, 'And tomorrow');
  assert.notEqual(t.captions.at(-1).id, last.id);
});

test('un texto largo sin puntuación no se acumula sin fin', async () => {
  const long = 'and then we went to the market and we bought apples and oranges and bananas and pears and lemons and then we walked home along the river and we saw the boats and the birds and the big old bridge and the tower';
  const t = setup({ heard: () => ({ text: long, lang: 'en' }), options: { minInterimMs: 60_000 } });
  await t.say();
  assert.equal(t.captions.at(-1).final, true);
  await t.say();
  assert.equal(t.translateCalls.at(-1).text, long, 'la segunda frase no debe arrastrar la primera');
});

test('en idiomas sin espacios los trozos se unen sin espacio', async () => {
  const texts = ['今日は', 'いい天気です。'];
  const t = setup({ heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'ja' }), options: { minInterimMs: 60_000 } });
  await t.say();
  await t.say();
  assert.equal(t.translateCalls.at(-1).text, '今日はいい天気です。');
});

// ---------- traducir no debe frenar el reconocimiento ----------

/** Traductor de pega cuyas respuestas se entregan a mano, en el orden que se quiera. */
function manualTranslator() {
  const requests = [];
  const translate = (text) =>
    new Promise((resolve) => requests.push({ text, done: () => resolve({ text: `ES(${text})`, engine: 'google' }) }));
  return { requests, translate };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const within = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms))]);

test('una traducción lenta no detiene el reconocimiento de voz', async () => {
  const slow = manualTranslator();
  const texts = ['Hello', 'Hello there', 'Hello there my friend'];
  const t = setup({ heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }), translate: slow.translate });
  t.feed(frames(1500, 0.3));
  await within(t.pipeline.step(), 500);
  t.feed(frames(600, 0.3));
  await within(t.pipeline.step(), 500);
  assert.equal(t.asrCalls.length, 2, 'la segunda pasada debe hacerse aunque la primera traducción no haya vuelto');
  assert.equal(t.captions.length, 0);
});

test('los subtítulos salen en orden aunque las traducciones vuelvan desordenadas', async () => {
  const slow = manualTranslator();
  const texts = ['Hello', 'Hello there'];
  const t = setup({ heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }), translate: slow.translate });
  t.feed(frames(1500, 0.3));
  await within(t.pipeline.step(), 500);
  t.feed(frames(600, 0.3));
  await within(t.pipeline.step(), 500);
  assert.equal(slow.requests.length, 2, 'las dos versiones se traducen a la vez');

  slow.requests[1].done();
  await settle();
  assert.deepEqual(t.captions, [], 'la segunda no puede adelantarse a la primera');
  slow.requests[0].done();
  await settle();
  assert.deepEqual(t.captions.map((c) => c.text), ['ES(Hello)', 'ES(Hello there)']);
  assert.ok(t.captions[1].rev > t.captions[0].rev);
});

test('si las traducciones se atascan, de las versiones en espera solo se traduce la más reciente', async () => {
  const slow = manualTranslator();
  const texts = ['uno', 'uno dos', 'uno dos tres', 'uno dos tres cuatro'];
  const t = setup({
    heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }),
    translate: slow.translate,
    options: { maxTranslations: 1 },
  });
  t.feed(frames(1500, 0.3));
  for (let i = 0; i < 4; i++) {
    await within(t.pipeline.step(), 500);
    t.feed(frames(600, 0.3));
  }
  assert.deepEqual(slow.requests.map((r) => r.text), ['uno'], 'solo cabe una traducción a la vez');
  slow.requests[0].done();
  await settle();
  assert.deepEqual(slow.requests.map((r) => r.text), ['uno', 'uno dos tres cuatro']);
  slow.requests[1].done();
  await settle();
  assert.deepEqual(t.captions.map((c) => c.text), ['ES(uno)', 'ES(uno dos tres cuatro)']);
});

test('la versión final de una frase nunca se descarta por haber otras en espera', async () => {
  const slow = manualTranslator();
  const texts = ['Hello', 'Hello there', 'Hello there.'];
  const t = setup({
    heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }),
    translate: slow.translate,
    options: { maxTranslations: 1 },
  });
  t.feed(frames(1500, 0.3));
  await within(t.pipeline.step(), 500);
  t.feed(frames(600, 0.3));
  await within(t.pipeline.step(), 500);
  t.feed(frames(1000, 0));
  await within(t.pipeline.step(), 500);
  while (slow.requests.some((r) => !r.finished)) {
    const next = slow.requests.find((r) => !r.finished);
    next.finished = true;
    next.done();
    await settle();
  }
  const last = t.captions.at(-1);
  assert.deepEqual({ text: last.text, final: last.final }, { text: 'ES(Hello there.)', final: true });
  assert.deepEqual(slow.requests.map((r) => r.text), ['Hello', 'Hello there.'], 'la versión intermedia sobraba');
});

test('se avisa al traductor de si la versión es provisional o final', async () => {
  const t = setup({ heard: (_a, _o, n) => ({ text: n === 1 ? 'Hello' : 'Hello there.', lang: 'en' }) });
  t.feed(frames(1500, 0.3));
  await t.drain();
  t.feed(frames(1000, 0));
  await t.drain();
  assert.deepEqual(t.translateCalls.map((c) => [c.text, c.final]), [['Hello', false], ['Hello there.', true]]);
});

test('una versión provisional que el traductor decide saltarse no llega a la pantalla', async () => {
  const skipped = Object.assign(new Error('demasiado seguido'), { code: 'skipped' });
  const t = setup({
    heard: (_a, _o, n) => ({ text: n === 1 ? 'Hello' : 'Hello there.', lang: 'en' }),
    translate: async (text, { final }) => {
      if (!final) throw skipped;
      return { text: `ES(${text})`, engine: 'google' };
    },
  });
  t.feed(frames(1500, 0.3));
  await t.drain();
  assert.deepEqual(t.captions, [], 'ni subtítulo ni texto original: simplemente se espera a la siguiente');
  t.feed(frames(1000, 0));
  await t.drain();
  assert.deepEqual(t.captions.map((c) => [c.text, c.final, c.engine]), [['ES(Hello there.)', true, 'google']]);
});

test('un trozo cortado a la fuerza no cierra frase aunque el reconocedor le ponga punto', async () => {
  // Nadie ha hecho una pausa: el audio se cortó por largo. Whisper acaba el
  // trozo con un punto, pero la frase sigue en el trozo siguiente.
  const texts = ['We are going to talk about black holes.', 'and why they are so fascinating.'];
  const t = setup({ heard: (_a, _o, n) => ({ text: texts[n - 1], lang: 'en' }), options: { minInterimMs: 60_000 } });
  t.feed(frames(9500, 0.3)); // 9,5 s sin parar: se corta a los 9 s
  await t.drain();
  assert.deepEqual(t.captions.map((c) => [c.original, c.final]), [['We are going to talk about black holes', false]]);

  t.feed(frames(1000, 0.3), frames(1000, 0));
  await t.drain();
  const last = t.captions.at(-1);
  assert.equal(last.original, 'We are going to talk about black holes and why they are so fascinating.');
  assert.equal(last.final, true);
});

test('un trozo que termina en una pausa sí cierra la frase con su punto', async () => {
  const t = setup({ heard: () => ({ text: 'We are going to talk about black holes.', lang: 'en' }), options: { minInterimMs: 60_000 } });
  await t.say();
  assert.deepEqual(t.captions.map((c) => [c.original, c.final]), [['We are going to talk about black holes.', true]]);
});

test('con el idioma ya asentado, se pide al reconocedor que no lo cambie por su cuenta', async () => {
  const t = setup({ heard: () => ({ text: 'Hello there.', lang: 'en', detected: { lang: 'en', prob: 0.95 } }) });
  for (let i = 0; i < 4; i++) await t.say(3000);
  assert.equal(t.asrCalls[0].locked, false, 'al principio el reconocedor puede elegir');
  assert.equal(t.asrCalls.at(-1).locked, true);
  assert.equal(t.asrCalls.at(-1).sticky, 'en');
});

test('unas risas detectadas como otro idioma no cambian el idioma con el que se sigue reconociendo', async () => {
  let laughing = false;
  const t = setup({
    // Como el reconocedor de verdad: si no se le fija el idioma, usa el que detecta.
    heard: (_audio, { sticky, locked }) =>
      laughing
        ? { text: 'Ysgwyth ysgwyth.', lang: locked ? sticky : 'cy', detected: { lang: 'cy', prob: 0.97 } }
        : { text: 'Hello there.', lang: 'en', detected: { lang: 'en', prob: 0.95 } },
    options: { minInterimMs: 60_000 },
  });
  for (let i = 0; i < 3; i++) await t.say(3000);
  laughing = true;
  await t.say(5000);
  laughing = false;
  await t.say(3000);
  assert.equal(t.asrCalls.at(-1).sticky, 'en');
});

test('al cambiar de vídeo el idioma del audio se vuelve a detectar desde cero', async () => {
  // Un idioma asentado tarda en cambiarse (a propósito); pero un vídeo nuevo
  // puede estar en otro idioma y no debe heredar el del anterior.
  const t = setup({ heard: () => ({ text: 'Hello there.', lang: 'en', detected: { lang: 'en', prob: 0.95 } }) });
  for (let i = 0; i < 4; i++) await t.say(3000);
  assert.equal(t.asrCalls.at(-1).locked, true);
  t.pipeline.startOver();
  await t.say(3000);
  assert.equal(t.asrCalls.at(-1).sticky, null);
  assert.equal(t.asrCalls.at(-1).locked, false);
});

test('al cambiar de vídeo se descarta el audio del anterior que quedaba por reconocer', async () => {
  // Si se reconociera después del cambio, volvería a fijar el idioma viejo.
  const t = setup();
  t.feed(frames(1500, 0.3), frames(1000, 0)); // una frase terminada, en cola
  t.feed(frames(1500, 0.3)); // y otra a medias
  t.pipeline.startOver();
  await t.drain();
  assert.equal(t.asrCalls.length, 0);
  assert.deepEqual(t.captions, []);
});

test('al cambiar de vídeo, la frase que estaba a medias en pantalla se da por terminada', async () => {
  const t = setup({ heard: () => ({ text: 'And tomorrow', lang: 'en' }), options: { minInterimMs: 60_000 } });
  await t.say();
  assert.equal(t.captions.at(-1).final, false);
  t.pipeline.startOver();
  await t.drain();
  const last = t.captions.at(-1);
  assert.deepEqual({ text: last.text, final: last.final }, { text: 'ES(And tomorrow)', final: true });
  // Lo siguiente ya es otra frase.
  await t.say();
  assert.equal(t.translateCalls.at(-1).text, 'And tomorrow');
});

test('una transcripción en bucle no se muestra y hace dudar del idioma asentado', async () => {
  let lost = false;
  const t = setup({
    heard: () =>
      lost
        ? { text: 'i wneud i wneud i wneud i wneud i wneud i wneud i wneud', lang: 'en', detected: { lang: 'en', prob: 0.9 } }
        : { text: 'Hello there.', lang: 'en', detected: { lang: 'en', prob: 0.95 } },
    options: { minInterimMs: 60_000 },
  });
  for (let i = 0; i < 4; i++) await t.say(3000);
  assert.equal(t.asrCalls.at(-1).locked, true);
  const shown = t.captions.length;
  lost = true;
  await t.say(3000);
  assert.equal(t.captions.length, shown, 'el bucle no debe llegar a la pantalla');
  lost = false;
  await t.say(3000);
  assert.equal(t.asrCalls.at(-1).locked, false, 'tras un bucle, el reconocedor vuelve a poder corregir el idioma');
});
