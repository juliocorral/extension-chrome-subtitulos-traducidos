import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WordStream, tokenize } from '../../extension/lib/word-stream.js';

/** Pasa por el flujo una versión del subtítulo y devuelve las palabras nuevas. */
function feed(stream, text, { id = 1, final = false, lang = 'es' } = {}) {
  return stream.push({ id, final, text, lang }).words.map((w) => w.text);
}

test('la primera versión de una frase no muestra nada: aún puede cambiar', () => {
  const stream = new WordStream();
  assert.deepEqual(feed(stream, 'Hola a todos'), []);
});

test('se muestran las palabras en las que coinciden dos versiones seguidas, salvo las dos últimas', () => {
  const stream = new WordStream();
  feed(stream, 'Hola a todos y');
  assert.deepEqual(feed(stream, 'Hola a todos y bienvenidos de'), ['Hola', 'a', 'todos', 'y']);
  assert.deepEqual(feed(stream, 'Hola a todos y bienvenidos de nuevo al'), ['bienvenidos', 'de']);
});

test('la versión final muestra todo lo que faltaba', () => {
  const stream = new WordStream();
  feed(stream, 'Hola a');
  feed(stream, 'Hola a todos y');
  assert.deepEqual(feed(stream, 'Hola a todos y bienvenidos.', { final: true }), ['todos', 'y', 'bienvenidos.']);
});

test('una frase que llega ya terminada se muestra entera', () => {
  const stream = new WordStream();
  assert.deepEqual(feed(stream, 'Muchas gracias.', { final: true }), ['Muchas', 'gracias.']);
});

test('las palabras ya mostradas no se repiten al llegar más versiones', () => {
  const stream = new WordStream();
  const shown = [];
  for (const text of ['Hola', 'Hola a todos', 'Hola a todos y', 'Hola a todos y bienvenidos']) {
    shown.push(...feed(stream, text));
  }
  shown.push(...feed(stream, 'Hola a todos y bienvenidos.', { final: true }));
  assert.deepEqual(shown, ['Hola', 'a', 'todos', 'y', 'bienvenidos.']);
});

test('una diferencia solo de puntuación o mayúsculas cuenta como coincidencia', () => {
  const stream = new WordStream();
  feed(stream, 'al canal y luego');
  // Se muestra la forma más reciente de cada palabra.
  assert.deepEqual(feed(stream, 'Al canal, y luego ya'), ['Al', 'canal,', 'y']);
});

test('la palabra que cierra una frase espera a que se confirme lo que viene detrás', () => {
  const stream = new WordStream();
  feed(stream, 'al canal.');
  // "canal." coincide en ambas, pero aún no se sabe si la frase acababa ahí.
  const shown = feed(stream, 'al canal. Hoy vamos');
  assert.deepEqual(shown, ['al']);
  // El reconocedor cambia de idea: no había punto.
  shown.push(...feed(stream, 'al canal de hoy. Vamos a hablar'));
  shown.push(...feed(stream, 'al canal de hoy. Vamos a hablar de'));
  assert.deepEqual(shown, ['al', 'canal', 'de', 'hoy.', 'Vamos', 'a'], 'no debe quedar un punto de más tras "canal"');
});

test('la palabra que cierra una frase se muestra en cuanto la siguiente también es estable', () => {
  const stream = new WordStream();
  feed(stream, 'al canal. Hoy vamos a');
  assert.deepEqual(feed(stream, 'al canal. Hoy vamos a hablar'), ['al', 'canal.', 'Hoy', 'vamos']);
});

test('si la traducción reescribe el principio, lo ya mostrado se queda y se sigue desde ahí', () => {
  const stream = new WordStream();
  feed(stream, 'El gato come');
  assert.deepEqual(feed(stream, 'El gato come pescado'), ['El', 'gato']);
  // El traductor cambia de idea con "El" → "Un": ya no se puede corregir en pantalla.
  assert.deepEqual(feed(stream, 'Un gato come pescado fresco'), []);
  assert.deepEqual(feed(stream, 'Un gato come pescado fresco hoy'), ['come', 'pescado']);
});

test('si la reescritura cambia el número de palabras, se retoma tras la última palabra mostrada', () => {
  const stream = new WordStream();
  feed(stream, 'al canal de hoy. Y luego ya');
  assert.deepEqual(feed(stream, 'al canal de hoy. Y luego ya'), ['al', 'canal', 'de', 'hoy.', 'Y']);
  // El traductor recoloca "hoy": «al canal. Hoy vamos a hablar de».
  assert.deepEqual(feed(stream, 'al canal. Hoy vamos a'), []);
  // "Hoy" ya está en pantalla (como "hoy."): no se repite ni se pierde "vamos".
  assert.deepEqual(feed(stream, 'al canal. Hoy vamos a hablar de'), ['vamos', 'a']);
});

test('si lo mostrado no encaja con la versión nueva, se sigue sin perder ninguna palabra', () => {
  const stream = new WordStream();
  feed(stream, 'al canal de la tele');
  assert.deepEqual(feed(stream, 'al canal de la tele'), ['al', 'canal', 'de']);
  // Ese "de" sobraba; no hay dónde retomar, así que lo nuevo se muestra entero.
  assert.deepEqual(feed(stream, 'al canal. Hoy vamos a'), []);
  assert.deepEqual(feed(stream, 'al canal. Hoy vamos a hablar de'), ['Hoy', 'vamos', 'a']);
});

test('las dos últimas palabras de una versión provisional se reservan: son las que más cambian', () => {
  // Medido sobre 150 s de un discurso real: reservar dos palabras en vez de
  // una deja un 36 % menos de palabras sobrantes por solo 0,1 s más de retraso.
  const stream = new WordStream();
  feed(stream, 'la relevancia de este');
  // Coinciden enteras, pero «de este» aún puede acabar siendo «de esta conferencia».
  assert.deepEqual(feed(stream, 'la relevancia de este'), ['la', 'relevancia']);
  // «de» ya coincide en dos versiones y no es de las dos últimas; «este» nunca llegó a mostrarse.
  assert.deepEqual(feed(stream, 'la relevancia de esta conferencia es'), ['de']);
  assert.deepEqual(feed(stream, 'la relevancia de esta conferencia es la razón'), ['esta', 'conferencia', 'es']);
});

test('una versión más corta que lo ya mostrado no añade nada', () => {
  const stream = new WordStream();
  feed(stream, 'uno dos tres cuatro');
  assert.deepEqual(feed(stream, 'uno dos tres cuatro'), ['uno', 'dos']);
  assert.deepEqual(feed(stream, 'uno dos'), []);
  assert.deepEqual(feed(stream, 'uno dos', { final: true }), []);
});

test('un subtítulo retirado (final y vacío) no añade nada', () => {
  const stream = new WordStream();
  feed(stream, 'eh');
  assert.deepEqual(feed(stream, '', { final: true }), []);
});

test('cada subtítulo nuevo empieza de cero', () => {
  const stream = new WordStream();
  feed(stream, 'Sí, claro.', { id: 1, final: true });
  feed(stream, 'Sí, claro', { id: 2 });
  assert.deepEqual(feed(stream, 'Sí, claro que sí', { id: 2 }), ['Sí,', 'claro']);
});

test('se marca la palabra que empieza frase: la primera de un subtítulo y la que sigue a un punto', () => {
  const stream = new WordStream();
  const { words } = stream.push({ id: 1, final: true, text: 'Es tarde. ¿Nos vamos? Vale', lang: 'es' });
  assert.deepEqual(
    words.map((w) => [w.text, w.sentenceStart]),
    [
      ['Es', true],
      ['tarde.', false],
      ['¿Nos', true],
      ['vamos?', false],
      ['Vale', true],
    ],
  );
  const next = stream.push({ id: 2, final: true, text: 'pues sí', lang: 'es' });
  assert.equal(next.words[0].sentenceStart, true, 'un subtítulo nuevo empieza frase aunque el anterior no acabara en punto');
  assert.equal(next.words[1].sentenceStart, false);
});

test('indica si el idioma separa las palabras con espacios', () => {
  const stream = new WordStream();
  assert.equal(stream.push({ id: 1, final: true, text: 'Hola a todos', lang: 'es' }).spaced, true);
  assert.equal(stream.push({ id: 2, final: true, text: '今日はいい天気です。', lang: 'ja' }).spaced, false);
});

test('en idiomas sin espacios el texto se trocea igualmente, sin perder nada', () => {
  const tokens = tokenize('今日はいい天気です。', 'ja');
  assert.ok(tokens.length > 1, 'debe partirse en varios trozos para poder mostrarlos de uno en uno');
  assert.equal(tokens.join(''), '今日はいい天気です。');
  assert.notEqual(tokens.at(-1), '。', 'la puntuación va pegada a la palabra anterior');
});

test('si al cerrarse una frase lo que venía detrás pasa al subtítulo siguiente, no se repite', () => {
  const stream = new WordStream();
  feed(stream, 'Hola a todos. Hoy vamos');
  assert.deepEqual(feed(stream, 'Hola a todos. Hoy vamos a hablar'), ['Hola', 'a', 'todos.', 'Hoy', 'vamos']);
  // La frase cerrada es solo "Hola a todos."; "Hoy vamos…" continúa en el subtítulo 2.
  assert.deepEqual(feed(stream, 'Hola a todos.', { id: 1, final: true }), []);
  // "Hoy vamos" ya está en pantalla, y "a hablar" ya coincidía con la versión
  // anterior: el subtítulo 2 sigue donde iba el 1, sin parón y sin empezar frase.
  const first = stream.push({ id: 2, final: false, text: 'Hoy vamos a hablar de', lang: 'es' });
  assert.deepEqual(first.words.map((w) => [w.text, w.sentenceStart]), [['a', false]]);
  assert.deepEqual(feed(stream, 'Hoy vamos a hablar de música', { id: 2 }), ['hablar']);
});

test('lo que pasa al subtítulo siguiente no se arrastra a los posteriores', () => {
  const stream = new WordStream();
  feed(stream, 'Vale. Y luego');
  feed(stream, 'Vale. Y luego');
  feed(stream, 'Vale.', { id: 1, final: true });
  feed(stream, 'Y luego nada.', { id: 2, final: true });
  assert.deepEqual(feed(stream, 'Y luego otra cosa.', { id: 3, final: true }), ['Y', 'luego', 'otra', 'cosa.']);
});

test('si el subtítulo se cierra con menos texto y otra puntuación, lo ya mostrado no se vuelve a escribir', () => {
  const stream = new WordStream();
  const long = 'hola a todos al canal de hoy. Vamos a hablar de los agujeros negros y por qué son tan fascinantes del';
  feed(stream, long);
  feed(stream, long); // en pantalla todo menos las dos últimas palabras
  // Se cierra solo con las dos primeras frases, y puntuadas de otra manera.
  assert.deepEqual(
    feed(stream, 'Hola a todos al canal. Hoy vamos a hablar de los agujeros negros.', { final: true }),
    [],
  );
  // El resto continúa en el subtítulo siguiente: solo falta por escribir el final.
  assert.deepEqual(
    feed(stream, 'y por qué son tan fascinantes del universo.', { id: 2, final: true }),
    ['fascinantes', 'del', 'universo.'],
  );
});

test('una coincidencia suelta en una frase completamente distinta no hace saltarse palabras', () => {
  const stream = new WordStream();
  feed(stream, 'El perro de Juan duerme mucho');
  assert.deepEqual(feed(stream, 'El perro de Juan duerme mucho'), ['El', 'perro', 'de', 'Juan']);
  assert.deepEqual(
    feed(stream, 'Un gato come pescado de río.', { final: true }),
    ['Un', 'gato', 'come', 'pescado', 'de', 'río.'],
  );
});

test('con palabras repetidas se retoma en la primera aparición, no en la última', () => {
  const stream = new WordStream();
  feed(stream, 'a la casa de la abuela Juana');
  assert.deepEqual(feed(stream, 'a la casa de la abuela Juana'), ['a', 'la', 'casa', 'de', 'la']);
  assert.deepEqual(
    feed(stream, 'a la casa de la playa de la ciudad.', { final: true }),
    ['playa', 'de', 'la', 'ciudad.'],
  );
});

test('una diferencia solo de tildes cuenta como coincidencia', () => {
  // El traductor a veces devuelve «como» y a la siguiente «cómo».
  const stream = new WordStream();
  feed(stream, 'hablar de como se forman los');
  assert.deepEqual(feed(stream, 'hablar de cómo se forman los agujeros'), ['hablar', 'de', 'cómo', 'se', 'forman']);
});

test('un texto ya mostrado sin tildes no se vuelve a escribir cuando llega con ellas', () => {
  const stream = new WordStream();
  const plain = 'al canal Hoy vamos a hablar sobre como se forman los agujeros negros y por que son tan fascinantes del';
  feed(stream, plain);
  feed(stream, plain);
  // La versión que cierra la frase llega con otra puntuación y con tildes.
  assert.deepEqual(
    feed(stream, 'al canal de hoy. Vamos a hablar sobre cómo se forman los agujeros negros', { final: true }),
    [],
  );
  assert.deepEqual(
    feed(stream, 'y por qué son tan fascinantes del universo.', { id: 2, final: true }),
    ['fascinantes', 'del', 'universo.'],
  );
});

test('una palabra corriente repetida más adelante no despista al retomar el texto', () => {
  // Caso visto en Chrome: en lo ya mostrado hay un «de» mucho más adelante
  // («algunos de los»). Al cerrar la frase con «…al canal de hoy.», ese «de»
  // lejano no debe tomarse por el de «canal de hoy».
  const stream = new WordStream();
  const shown =
    'hola a todos y bienvenidos de nuevo al canal Hoy vamos a hablar sobre como se forman los agujeros negros y por que son algunos de los mas objetos más fascinantes del';
  feed(stream, shown);
  feed(stream, shown);
  assert.deepEqual(feed(stream, 'Hola a todos y bienvenidos de nuevo al canal de hoy.', { final: true }), []);
  assert.deepEqual(
    feed(
      stream,
      'Vamos a hablar sobre cómo se forman los agujeros negros y por qué son algunos de los objetos más fascinantes del universo.',
      { id: 2, final: true },
    ),
    ['fascinantes', 'del', 'universo.'],
  );
});
