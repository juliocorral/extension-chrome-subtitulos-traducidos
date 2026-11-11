// Reconocimiento de voz con Whisper (transformers.js), dentro de un worker
// para no bloquear la captura de audio. Usa WebGPU si existe y, si no, WASM.
import {
  AutoProcessor,
  AutoTokenizer,
  WhisperForConditionalGeneration,
  LogitsProcessor,
  LogitsProcessorList,
  env,
} from './vendor/transformers.min.js';
import { chooseLanguage, rankLanguages } from './lib/langs.js';

// Manifest V3 no permite código remoto: el runtime de ONNX va en la extensión.
env.allowLocalModels = false;
env.useWasmCache = false; // evitaría el import() directo usando blob:, que la CSP bloquea
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('./vendor/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('./vendor/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};

const SAMPLE_RATE = 16000;
let loaded = null; // { repo, model, processor, tokenizer, device, langs }

/**
 * Whisper elige el idioma con su primer token. transformers.js no implementa
 * esa detección (asume inglés), así que la hacemos aquí: en el primer paso
 * dejamos que el modelo puntúe solo los tokens de idioma, elegimos uno y
 * forzamos después "transcribir" y "sin marcas de tiempo". Así la detección
 * no cuesta una pasada extra del modelo.
 */
class LanguagePrefixProcessor extends LogitsProcessor {
  constructor(langs, { sticky, audioSeconds, locked, allowed }) {
    super();
    this.langs = langs;
    this.allowed = allowed; // idiomas entre los que se puede elegir, o null
    this.sticky = sticky;
    this.audioSeconds = audioSeconds;
    this.locked = locked; // true: se usa `sticky` diga lo que diga la detección
    this.chosen = null;
    this.detected = null; // lo que Whisper cree oír: { lang, prob }
  }

  _call(input_ids, logits) {
    for (let i = 0; i < input_ids.length; ++i) {
      const data = logits[i].data;
      const step = input_ids[i].length;
      let forced = null;
      if (step === 1) {
        const scores = this.langs.ids.map((id) => [this.langs.codeOf.get(id), data[id]]);
        const ranked = rankLanguages(scores, this.allowed);
        this.detected = { lang: ranked[0][0], prob: ranked[0][1] };
        this.chosen =
          this.locked && this.sticky
            ? this.sticky
            : chooseLanguage(ranked, { sticky: this.sticky, audioSeconds: this.audioSeconds });
        forced = this.langs.idOf.get(this.chosen) ?? this.langs.idOf.get(ranked[0][0]);
      } else if (step === 2) {
        forced = this.langs.transcribe;
      } else if (step === 3) {
        forced = this.langs.noTimestamps;
      }
      if (forced !== null) {
        data.fill(-Infinity);
        data[forced] = 0;
      }
    }
    return logits;
  }
}

function progressReporter() {
  const files = new Map();
  let last = -1;
  return (event) => {
    if (event.status !== 'progress' || !event.total) return;
    files.set(event.file, [event.loaded, event.total]);
    let loadedBytes = 0;
    let totalBytes = 0;
    for (const [l, t] of files.values()) {
      loadedBytes += l;
      totalBytes += t;
    }
    const percent = Math.floor((loadedBytes / totalBytes) * 100);
    if (percent !== last) {
      last = percent;
      postMessage({ type: 'status', phase: 'loading-model', progress: percent });
    }
  };
}

async function hasWebGpu() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function load(repo) {
  if (loaded?.repo === repo) {
    postMessage({ type: 'status', phase: 'ready', device: loaded.device });
    return;
  }
  if (loaded) {
    await loaded.model.dispose?.().catch(() => {});
    loaded = null;
  }
  postMessage({ type: 'status', phase: 'loading-model', progress: null });

  const attempts = [{ device: 'wasm', dtype: 'q8' }];
  if (await hasWebGpu()) {
    attempts.unshift({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
  }

  let model = null;
  let device = null;
  let failure = null;
  for (const attempt of attempts) {
    try {
      model = await WhisperForConditionalGeneration.from_pretrained(repo, {
        ...attempt,
        progress_callback: progressReporter(),
      });
      device = attempt.device;
      break;
    } catch (err) {
      failure = err;
      console.warn(`[subtítulos] no se pudo cargar con ${attempt.device}:`, err);
    }
  }
  if (!model) throw failure;

  const [processor, tokenizer] = await Promise.all([
    AutoProcessor.from_pretrained(repo),
    AutoTokenizer.from_pretrained(repo),
  ]);

  const config = model.generation_config;
  const langEntries = Object.entries(config.lang_to_id).map(([token, id]) => [token.slice(2, -2), id]);
  const langs = {
    ids: langEntries.map(([, id]) => id),
    idOf: new Map(langEntries),
    codeOf: new Map(langEntries.map(([code, id]) => [id, code])),
    transcribe: config.task_to_id.transcribe,
    noTimestamps: config.no_timestamps_token_id,
    start: config.decoder_start_token_id,
  };

  loaded = { repo, model, processor, tokenizer, device, langs };

  // Primera inferencia en vacío: compila los shaders de WebGPU para que la
  // primera frase real no llegue con retraso.
  await transcribe(new Float32Array(SAMPLE_RATE), { language: 'en', sticky: null });

  postMessage({ type: 'status', phase: 'ready', device });
}

async function transcribe(audio, { language, sticky, locked = false, allowed = null }) {
  const { model, processor, tokenizer, langs } = loaded;
  const seconds = audio.length / SAMPLE_RATE;

  // Iguala el volumen: el audio de una pestaña con el volumen bajo llega muy flojo.
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const v = Math.abs(audio[i]);
    if (v > peak) peak = v;
  }
  if (peak > 0.001 && peak < 0.5) {
    const gain = Math.min(0.5 / peak, 20);
    for (let i = 0; i < audio.length; i++) audio[i] *= gain;
  }

  const inputs = await processor(audio);
  const max_new_tokens = Math.min(200, Math.ceil(seconds * 12) + 24);

  let output;
  let lang = language;
  let detected;
  if (language && langs.idOf.has(language)) {
    output = await model.generate({ ...inputs, language, task: 'transcribe', max_new_tokens });
  } else {
    const prefix = new LanguagePrefixProcessor(langs, {
      sticky,
      audioSeconds: seconds,
      locked,
      allowed: allowed ? new Set(allowed) : null,
    });
    const processors = new LogitsProcessorList();
    processors.push(prefix);
    output = await model.generate({
      ...inputs,
      decoder_input_ids: [langs.start],
      logits_processor: processors,
      max_new_tokens: max_new_tokens + 3,
    });
    lang = prefix.chosen;
    detected = prefix.detected;
  }

  const text = tokenizer.batch_decode(output, { skip_special_tokens: true })[0] ?? '';
  return { text, lang, detected };
}

// Las peticiones se atienden de una en una, en orden.
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    try {
      if (data.type === 'load') {
        await load(data.repo);
      } else if (data.type === 'transcribe') {
        const started = performance.now();
        const result = await transcribe(data.audio, data);
        postMessage({ type: 'result', id: data.id, ...result, ms: Math.round(performance.now() - started) });
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      if (data.type === 'transcribe') postMessage({ type: 'result', id: data.id, error: message });
      else postMessage({ type: 'status', phase: 'error', message });
    }
  });
};
