// Copia a extension/vendor los ficheros de terceros que la extensión necesita
// (Manifest V3 no permite cargar código remoto, así que todo va empaquetado).
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'vendor');
mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm'],
];

for (const [from, to] of files) {
  copyFileSync(join(root, from), join(out, to));
  const mb = (statSync(join(out, to)).size / 1048576).toFixed(1);
  console.log(`vendor/${to}  ${mb} MB`);
}
