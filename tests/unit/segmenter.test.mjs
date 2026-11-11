import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceSegmenter } from '../../extension/lib/segmenter.js';

const RATE = 16000;
const FRAME = 1600; // 100 ms

/** Tramas de 100 ms con un tono de amplitud `amp` (0 = silencio digital). */
function frames(ms, amp) {
  const out = [];
  for (let f = 0; f < ms / 100; f++) {
    const frame = new Float32Array(FRAME);
    if (amp > 0) {
      for (let i = 0; i < FRAME; i++) frame[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
    }
    out.push(frame);
  }
  return out;
}

function feed(seg, ...groups) {
  for (const group of groups) for (const frame of group) seg.push(frame);
}

const ms = (audio) => (audio.length / RATE) * 1000;
const loudSamples = (audio, level) => audio.reduce((n, x) => n + (Math.abs(x) > level ? 1 : 0), 0);

test('el silencio no abre ninguna frase', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(3000, 0));
  assert.deepEqual(seg.takeFinals(), []);
  assert.equal(seg.current(), null);
});

test('voz seguida de una pausa se entrega como una frase terminada', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(500, 0), frames(1000, 0.3), frames(1000, 0));
  const finals = seg.takeFinals();
  assert.equal(finals.length, 1);
  // Contiene el segundo entero de voz (un seno supera 0.1 en ~78 % de sus muestras)...
  assert.ok(loudSamples(finals[0].audio, 0.1) > 12000, 'falta parte de la voz');
  // ...y no arrastra todo el silencio de alrededor.
  assert.ok(ms(finals[0].audio) < 2100, `demasiado larga: ${ms(finals[0].audio)} ms`);
  assert.equal(seg.current(), null);
});

test('las frases terminadas se entregan una sola vez', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1000, 0.3), frames(1000, 0));
  assert.equal(seg.takeFinals().length, 1);
  assert.deepEqual(seg.takeFinals(), []);
});

test('mientras se sigue hablando la frase crece sin darse por terminada', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(2000, 0.3));
  assert.deepEqual(seg.takeFinals(), []);
  const first = seg.current();
  assert.ok(first.audio.length >= 2 * RATE);
  feed(seg, frames(1000, 0.3));
  const second = seg.current();
  assert.equal(second.id, first.id);
  assert.ok(second.audio.length >= 3 * RATE);
});

test('cada frase nueva recibe un identificador distinto', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1000, 0.3), frames(1000, 0));
  const [a] = seg.takeFinals();
  feed(seg, frames(1000, 0.3), frames(1000, 0));
  const [b] = seg.takeFinals();
  assert.notEqual(a.id, b.id);
});

test('una pausa breve dentro de la frase no la parte', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1000, 0.3), frames(300, 0), frames(1000, 0.3), frames(1000, 0));
  const finals = seg.takeFinals();
  assert.equal(finals.length, 1);
  assert.ok(loudSamples(finals[0].audio, 0.1) > 24000, 'debe incluir los dos tramos de voz');
});

test('un chasquido aislado se descarta', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(500, 0), frames(100, 0.3), frames(1500, 0));
  assert.deepEqual(seg.takeFinals(), []);
  assert.equal(seg.current(), null);
});

test('conserva el arranque de la frase aunque empiece por debajo del umbral', () => {
  const seg = new UtteranceSegmenter();
  // 200 ms muy suaves (por debajo del umbral) justo antes de la voz clara.
  feed(seg, frames(1000, 0), frames(200, 0.001), frames(1000, 0.3), frames(1000, 0));
  const [utt] = seg.takeFinals();
  const head = utt.audio.subarray(0, 4800);
  assert.ok(loudSamples(head, 0.0005) > 1000, 'se ha recortado el arranque suave');
});

test('una locución larga y continua se corta en su momento más bajo sin perder audio', () => {
  const seg = new UtteranceSegmenter({ maxUtteranceMs: 9000 });
  // 12 s de voz continua con un bache (más flojo, pero no silencio) en 7,5 s.
  feed(seg, frames(7500, 0.3), frames(100, 0.05), frames(4400, 0.3));
  const finals = seg.takeFinals();
  assert.equal(finals.length, 1, 'al superar el máximo debe forzarse un corte');
  assert.ok(Math.abs(ms(finals[0].audio) - 7600) <= 100, `corte en ${ms(finals[0].audio)} ms, esperado ~7600`);
  const rest = seg.current();
  assert.notEqual(rest.id, finals[0].id);
  assert.equal(finals[0].audio.length + rest.audio.length, 12 * RATE, 'se ha perdido o duplicado audio');
});

test('con ruido de fondo constante la frase termina cuando calla el hablante', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(2000, 0.02), frames(1500, 0.3), frames(1500, 0.02));
  const finals = seg.takeFinals();
  assert.equal(finals.length, 1);
  assert.ok(loudSamples(finals[0].audio, 0.1) > 18000);
  assert.equal(seg.current(), null, 'el ruido de fondo no debe abrir otra frase');
});

test('dos frases cortas separadas por una pausa de 0,8 s se entregan juntas', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1200, 0.3), frames(800, 0), frames(1200, 0.3), frames(1200, 0));
  const finals = seg.takeFinals();
  assert.equal(finals.length, 1, 'una pausa corta tras una frase breve no debe partirla');
  assert.ok(loudSamples(finals[0].audio, 0.1) > 28000, 'deben estar los dos tramos de voz');
});

test('una frase de duración media aguanta una pausa de 0,4 s pero se cierra a los 0,6 s', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(4000, 0.3), frames(400, 0));
  assert.deepEqual(seg.takeFinals(), []);
  feed(seg, frames(200, 0));
  assert.equal(seg.takeFinals().length, 1);
});

test('tras una locución larga basta una pausa de 0,4 s para cerrarla', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(7000, 0.3), frames(400, 0));
  assert.equal(seg.takeFinals().length, 1);
});

test('la frase entregada no arrastra más de 0,3 s de silencio final', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1000, 0.3), frames(1500, 0));
  const [utt] = seg.takeFinals();
  assert.ok(ms(utt.audio) <= 1300, `dura ${ms(utt.audio)} ms`);
});

// ---------- volumen bajo (por ejemplo, el reproductor de YouTube al 10 %) ----------

/** Voz floja y de nivel muy parejo: ninguna trama baja de un 70 % del nivel medio. */
function steadyQuietSpeech(ms) {
  return Array.from({ length: ms / 100 }, (_, i) => frames(100, i % 2 ? 0.012 : 0.009)[0]);
}

function totalMs(seg, finals) {
  const audio = [...finals.map((f) => f.audio), seg.current()?.audio ?? new Float32Array(0)];
  return (audio.reduce((n, a) => n + a.length, 0) / RATE) * 1000;
}

test('una voz floja y sostenida se sigue detectando al cabo de unos segundos', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1000, 0), steadyQuietSpeech(12_000));
  const heard = totalMs(seg, seg.takeFinals());
  assert.ok(heard >= 11_500, `de 12 s de voz solo se han recogido ${Math.round(heard / 100) / 10} s`);
});

test('una voz floja y sostenida se sigue detectando aunque no haya ni una pausa en medio minuto', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1000, 0), steadyQuietSpeech(30_000));
  const heard = totalMs(seg, seg.takeFinals());
  assert.ok(heard >= 29_000, `de 30 s de voz solo se han recogido ${Math.round(heard / 100) / 10} s`);
});

test('con la voz floja, el ruido de fondo aún más flojo no cuenta como voz', () => {
  const seg = new UtteranceSegmenter();
  // Ruido 0,002 de fondo todo el rato; voz 0,012 durante 2 s.
  feed(seg, frames(1500, 0.002), frames(2000, 0.012), frames(3000, 0.002));
  const finals = seg.takeFinals();
  assert.equal(finals.length, 1);
  assert.equal(seg.current(), null, 'el ruido de después no debe abrir otra frase');
});

test('se indica si la frase se cortó a la fuerza o terminó en una pausa', () => {
  const seg = new UtteranceSegmenter({ maxUtteranceMs: 9000 });
  feed(seg, frames(9500, 0.3), frames(1000, 0));
  const [cut, paused] = seg.takeFinals();
  assert.equal(cut.forced, true, 'la primera se cortó por larga, sin pausa');
  assert.equal(Boolean(paused.forced), false, 'la segunda terminó porque el hablante calló');
});

test('reset() descarta la frase en curso y las terminadas sin entregar', () => {
  const seg = new UtteranceSegmenter();
  feed(seg, frames(1500, 0.3), frames(1000, 0), frames(1500, 0.3));
  seg.reset();
  assert.equal(seg.current(), null);
  assert.deepEqual(seg.takeFinals(), []);
  // Y sigue funcionando con el audio nuevo.
  feed(seg, frames(1500, 0.3), frames(1000, 0));
  assert.equal(seg.takeFinals().length, 1);
});
