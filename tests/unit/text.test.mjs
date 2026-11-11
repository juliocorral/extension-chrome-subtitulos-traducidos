import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, looksDegenerate } from '../../extension/lib/text.js';

test('quita las etiquetas de sonido entre corchetes o paréntesis', () => {
  assert.equal(cleanTranscript(' [Music] Hello there (applause)'), 'Hello there');
});

test('un texto que solo son etiquetas queda vacío', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' (música) '), '');
  assert.equal(cleanTranscript('*laughs*'), '');
});

test('quita las notas musicales pero conserva la letra', () => {
  assert.equal(cleanTranscript('♪ la vie en rose ♪'), 'la vie en rose');
});

test('descarta los créditos de subtítulos que Whisper inventa en los silencios', () => {
  assert.equal(cleanTranscript('Subtítulos realizados por la comunidad de Amara.org'), '');
  assert.equal(cleanTranscript("Sous-titres réalisés par la communauté d'Amara.org"), '');
  assert.equal(cleanTranscript('Untertitel der Amara.org-Community'), '');
});

test('colapsa una frase repetida varias veces dentro de un texto normal', () => {
  assert.equal(
    cleanTranscript('And then he said thank you thank you thank you thank you and left the room without another word.'),
    'And then he said thank you and left the room without another word.',
  );
});

test('respeta el texto normal, incluidas repeticiones legítimas', () => {
  assert.equal(cleanTranscript('That is very very good.'), 'That is very very good.');
  assert.equal(cleanTranscript('No, no, no. Listen to me.'), 'No, no, no. Listen to me.');
});

test('normaliza los espacios', () => {
  assert.equal(cleanTranscript('  Hola   a \n todos  '), 'Hola a todos');
});

test('tolera entradas vacías', () => {
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript(undefined), '');
});

// Cuando Whisper se pierde (idioma equivocado, ruido), entra en bucle y repite
// una sílaba o un par de palabras. Ejemplos tomados de una sesión real.
test('reconoce las transcripciones que son un bucle sin sentido', () => {
  assert.equal(looksDegenerate('i wneud i wneud i wneud i wneud i wneud i wneud i wneud'), true);
  assert.equal(looksDegenerate("Ia wétho'i ddododododododododododododododododod"), true);
  assert.equal(looksDegenerate("Befo'r rai, rai o'r gau'r gau'r gau'r gau'r gau'r gau'r gau"), true);
  assert.equal(looksDegenerate('i wahanau i wahanau i wahanau i wahanau i wahanau i wahanau'), true);
});

test('no toma por bucle el habla normal, aunque repita palabras', () => {
  assert.equal(looksDegenerate('We are the home of the rugby world cup and we are hosts of the cricket world cup.'), false);
  assert.equal(looksDegenerate('No, no, no. Listen to me.'), false);
  assert.equal(looksDegenerate('Que sí, que sí, que ya voy.'), false);
  assert.equal(looksDegenerate(''), false);
});

test('una transcripción en bucle se descarta entera en vez de limpiarse', () => {
  assert.equal(cleanTranscript('i wneud i wneud i wneud i wneud i wneud i wneud i wneud'), '');
  assert.equal(cleanTranscript('thank you thank you thank you thank you thank you thank you'), '');
});
