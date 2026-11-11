import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/shared/config.js';
import '../../extension/shared/rollup.js';

const { RollUp, Revealer, revealDelay } = globalThis.LT;

// Para las pruebas, el ancho de un texto es su número de caracteres.
const measure = (text) => text.length;

function rollup(options = {}) {
  return new RollUp({ maxLines: 2, maxWidth: 20, measure, ...options });
}

const add = (r, text, sentenceStart = false) => r.add({ text, sentenceStart });
const texts = (r) => r.lines.map((line) => line.words.join(' '));

// ---------- líneas que suben ----------

test('las palabras van llenando la línea de izquierda a derecha', () => {
  const r = rollup();
  for (const word of ['Hola', 'a', 'todos']) add(r, word);
  assert.deepEqual(texts(r), ['Hola a todos']);
});

test('la palabra que no cabe abre una línea nueva debajo y la anterior no cambia', () => {
  const r = rollup();
  for (const word of ['Hola', 'a', 'todos', 'y', 'bien']) add(r, word); // "Hola a todos y bien" = 19
  add(r, 'venidos');
  assert.deepEqual(texts(r), ['Hola a todos y bien', 'venidos']);
});

test('nunca hay más líneas de las pedidas: al abrir otra desaparece la de arriba', () => {
  const r = rollup();
  for (const word of ['primera', 'línea', 'entera', 'segunda', 'línea', 'entera', 'tercera']) add(r, word);
  // "primera línea entera" = 20, "segunda línea entera" = 20
  assert.deepEqual(texts(r), ['segunda línea entera', 'tercera']);
});

test('add() avisa de cuándo se ha abierto una línea', () => {
  const r = rollup();
  assert.equal(add(r, 'Hola').newLine, true, 'la primera palabra abre la primera línea');
  assert.equal(add(r, 'a').newLine, false);
  for (const word of ['todos', 'y', 'bien']) add(r, word);
  assert.equal(add(r, 'venidos').newLine, true);
});

test('cada línea conserva su identificador mientras está en pantalla', () => {
  const r = rollup();
  for (const word of ['primera', 'línea', 'entera', 'segunda']) add(r, word);
  const [first, second] = r.lines.map((line) => line.id);
  assert.notEqual(first, second);
  for (const word of ['línea', 'entera', 'tercera']) add(r, word);
  assert.equal(r.lines[0].id, second, 'la segunda línea sube pero sigue siendo la misma');
  assert.ok(!r.lines.some((line) => line.id === first));
});

test('una frase nueva empieza en línea nueva si la actual ya va por la mitad', () => {
  const r = rollup();
  for (const word of ['Hola', 'a', 'todos.']) add(r, word); // 13 de 20
  add(r, 'Hoy', true);
  assert.deepEqual(texts(r), ['Hola a todos.', 'Hoy']);
});

test('una frase nueva sigue en la misma línea si esta apenas tiene texto', () => {
  const r = rollup();
  add(r, 'Sí.');
  add(r, 'Claro.', true);
  add(r, 'Vale.', true); // "Sí. Claro." = 10: justo la mitad → ya salta
  assert.deepEqual(texts(r), ['Sí. Claro.', 'Vale.']);
});

test('una palabra más ancha que la línea ocupa una línea ella sola', () => {
  const r = rollup();
  add(r, 'uno');
  add(r, 'esternocleidomastoideo');
  add(r, 'dos');
  assert.deepEqual(texts(r), ['esternocleidomastoideo', 'dos']);
});

test('en idiomas sin espacios las palabras se pegan y se miden sin separación', () => {
  const r = rollup({ spaced: false, maxWidth: 6 });
  for (const word of ['今日', 'は', 'いい', '天気', 'です。']) add(r, word);
  assert.deepEqual(r.lines.map((line) => line.words.join('')), ['今日はいい', '天気です。']);
});

test('clear() deja la pantalla vacía', () => {
  const r = rollup();
  add(r, 'Hola');
  r.clear();
  assert.deepEqual(r.lines, []);
});

test('al cambiar el ancho o el número de líneas se recoloca el texto visible', () => {
  const r = rollup();
  for (const word of ['Hola', 'a', 'todos', 'y', 'bien', 'venidos', 'al', 'canal']) add(r, word);
  assert.deepEqual(texts(r), ['Hola a todos y bien', 'venidos al canal']);
  r.resize({ maxWidth: 40 });
  assert.deepEqual(texts(r), ['Hola a todos y bien venidos al canal']);
  // Con 12 de ancho: "Hola a todos" / "y bien" / "venidos al" / "canal" → quedan las dos últimas.
  r.resize({ maxWidth: 12, maxLines: 2 });
  assert.deepEqual(texts(r), ['venidos al', 'canal']);
});

// ---------- aparición palabra a palabra ----------

test('el ritmo de aparición se acelera cuando hay muchas palabras esperando', () => {
  assert.equal(revealDelay(1), 120);
  assert.equal(revealDelay(4), 120);
  assert.equal(revealDelay(6), 80);
  assert.equal(revealDelay(12), 40);
  assert.equal(revealDelay(60), 40, 'pero nunca tan rápido que parezcan salir a la vez');
});

/** Reloj de pega: los temporizadores solo saltan al avanzar el tiempo a mano. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

test('las palabras que llegan juntas se muestran de una en una, en orden', () => {
  const clock = fakeClock();
  const shown = [];
  const revealer = new Revealer({ onWord: (word) => shown.push(word.text), ...clock });
  revealer.enqueue([{ text: 'Hola' }, { text: 'a' }, { text: 'todos' }]);
  assert.deepEqual(shown, ['Hola'], 'la primera sale al momento');
  clock.advance(119);
  assert.deepEqual(shown, ['Hola']);
  clock.advance(1);
  assert.deepEqual(shown, ['Hola', 'a']);
  clock.advance(120);
  assert.deepEqual(shown, ['Hola', 'a', 'todos']);
});

test('las palabras que llegan mientras otras esperan se ponen a la cola', () => {
  const clock = fakeClock();
  const shown = [];
  const revealer = new Revealer({ onWord: (word) => shown.push(word.text), ...clock });
  revealer.enqueue([{ text: 'uno' }, { text: 'dos' }]);
  revealer.enqueue([{ text: 'tres' }]);
  clock.advance(1000);
  assert.deepEqual(shown, ['uno', 'dos', 'tres']);
});

test('tras una pausa, la siguiente palabra vuelve a salir al momento', () => {
  const clock = fakeClock();
  const shown = [];
  const revealer = new Revealer({ onWord: (word) => shown.push(word.text), ...clock });
  revealer.enqueue([{ text: 'uno' }]);
  clock.advance(2000);
  revealer.enqueue([{ text: 'dos' }]);
  assert.deepEqual(shown, ['uno', 'dos']);
});

test('dos palabras nunca salen pegadas aunque lleguen por separado', () => {
  const clock = fakeClock();
  const shown = [];
  const revealer = new Revealer({ onWord: (word) => shown.push(word.text), ...clock });
  revealer.enqueue([{ text: 'uno' }]);
  clock.advance(10);
  revealer.enqueue([{ text: 'dos' }]);
  assert.deepEqual(shown, ['uno'], 'la segunda espera su turno');
  clock.advance(110);
  assert.deepEqual(shown, ['uno', 'dos']);
});

test('stop() descarta lo que quedaba por mostrar', () => {
  const clock = fakeClock();
  const shown = [];
  const revealer = new Revealer({ onWord: (word) => shown.push(word.text), ...clock });
  revealer.enqueue([{ text: 'uno' }, { text: 'dos' }, { text: 'tres' }]);
  revealer.stop();
  clock.advance(1000);
  assert.deepEqual(shown, ['uno']);
});

test('si se acumulan demasiadas palabras (pestaña en segundo plano) se saltan las más antiguas', () => {
  const clock = fakeClock();
  const shown = [];
  const revealer = new Revealer({ onWord: (word) => shown.push(word.text), ...clock });
  revealer.enqueue(Array.from({ length: 200 }, (_, i) => ({ text: `p${i}` })));
  clock.advance(60_000);
  assert.equal(shown.at(-1), 'p199', 'lo último que se dijo debe acabar en pantalla');
  assert.ok(shown.length <= 41, `se han mostrado ${shown.length} palabras: la cola no tiene tope`);
});
