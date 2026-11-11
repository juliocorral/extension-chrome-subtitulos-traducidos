// Documento offscreen: recibe el audio de la pestaña, lo deja sonar, lo pasa
// por Whisper (en un worker) y por el traductor, y emite los subtítulos.
// Aquí solo está disponible chrome.runtime: los ajustes llegan por mensaje.
import { UtteranceSegmenter } from './lib/segmenter.js';
import { CaptionPipeline } from './lib/pipeline.js';
import { TranslationService } from './lib/translation-service.js';
import { createChromeEngine } from './lib/chrome-translator.js';
import { createGoogleEngine } from './lib/google-translate.js';
import { pickModel } from './lib/models.js';
import { WordStream } from './lib/word-stream.js';

const { MODELS, SOURCE_LANGUAGES } = globalThis.LT;
// La detección automática del idioma solo elige entre los que ofrece la extensión.
const DETECTABLE = SOURCE_LANGUAGES.map((language) => language.code).filter((code) => code !== 'auto');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});

class Session {
  constructor(settings) {
    this.settings = settings;
    this.running = true;
    this.modelReady = false;
    this.status = { phase: 'starting' };
    this.requests = new Map();
    this.nextRequest = 1;
    this.words = new WordStream();
    this.translation = new TranslationService({
      chrome: createChromeEngine(),
      google: createGoogleEngine(),
      mode: settings.engine,
    });
    this.pipeline = new CaptionPipeline({
      segmenter: new UtteranceSegmenter(),
      settings: () => this.settings,
      transcribe: (audio, options) => this.transcribe(audio, options),
      translate: (text, options) => this.translation.translate(text, options),
      emit: (caption) => this.emit(caption),
    });
  }

  async open(streamId) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
    const [track] = this.stream.getAudioTracks();
    track.addEventListener('ended', () => send({ type: 'lt:ended' }));

    // Al capturar una pestaña Chrome deja de reproducirla: la devolvemos a los altavoces.
    this.playback = new AudioContext();
    this.playback.createMediaStreamSource(this.stream).connect(this.playback.destination);

    // Copia en mono a 16 kHz (lo que espera Whisper), troceada en tramas de 100 ms.
    this.capture = new AudioContext({ sampleRate: 16000 });
    await this.capture.audioWorklet.addModule('audio-worklet.js');
    const tap = new AudioWorkletNode(this.capture, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    tap.port.onmessage = ({ data }) => {
      if (this.running && this.modelReady) this.pipeline.pushFrame(data);
    };
    const silent = this.capture.createGain();
    silent.gain.value = 0;
    this.capture.createMediaStreamSource(this.stream).connect(tap).connect(silent).connect(this.capture.destination);
    await Promise.all([this.playback.resume(), this.capture.resume()]);

    this.worker = new Worker('asr-worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }) => this.onWorkerMessage(data);
    this.worker.onerror = (event) => {
      this.setStatus({ phase: 'error', message: `No se pudo iniciar el reconocimiento de voz: ${event.message}` });
    };
    this.loadModel();
    this.run();
  }

  async loadModel() {
    this.modelReady = false;
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    if (!this.running) return;
    this.model = pickModel(this.settings.model, {
      webgpu: Boolean(adapter),
      vendor: adapter?.info?.vendor ?? '',
    });
    this.setStatus({ phase: 'loading-model', progress: null, model: this.model });
    this.worker.postMessage({ type: 'load', repo: MODELS.find((m) => m.code === this.model).repo });
  }

  onWorkerMessage(data) {
    if (data.type === 'result') {
      const request = this.requests.get(data.id);
      this.requests.delete(data.id);
      if (!request) return;
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data);
    } else if (data.type === 'status') {
      if (data.phase === 'ready') {
        this.modelReady = true;
        this.setStatus({ phase: 'listening', device: data.device, model: this.model });
      } else if (data.phase === 'loading-model') {
        this.setStatus({ phase: 'loading-model', progress: data.progress, model: this.model });
      } else if (data.phase === 'error') {
        this.setStatus({ phase: 'error', message: `No se pudo cargar el modelo de voz: ${data.message}` });
      }
    }
  }

  transcribe(audio, { language, sticky, locked }) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequest++;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, audio, language, sticky, locked, allowed: DETECTABLE }, [
        audio.buffer,
      ]);
    });
  }

  emit(caption) {
    // A la barra no se le manda el texto entero de cada versión, sino solo las
    // palabras nuevas que ya son estables: así nunca tiene que reescribir nada.
    const translated = caption.engine === 'chrome' || caption.engine === 'google';
    const { words, spaced } = this.words.push({
      id: caption.id,
      final: caption.final,
      text: caption.text,
      lang: translated ? this.settings.targetLang : caption.lang,
    });
    send({
      type: 'lt:caption',
      caption: { id: caption.id, final: caption.final, words, spaced, original: caption.original },
    });
    if (!caption.engine) return;
    // El popup muestra con qué motor se está traduciendo.
    const translator = {
      engine: caption.engine,
      fallback: caption.fallback ?? null,
      error: caption.error ?? null,
      source: caption.lang ?? null,
      target: this.settings.targetLang,
    };
    const changed = JSON.stringify(translator) !== JSON.stringify(this.status.translator);
    if (changed || this.status.phase !== 'listening') {
      this.setStatus({ ...this.status, phase: 'listening', message: undefined, translator });
    }
  }

  setStatus(status) {
    this.status = status;
    if (this.running) send({ type: 'lt:status', status });
  }

  applySettings(settings) {
    const previous = this.settings;
    this.settings = settings;
    this.translation.setMode(settings.engine);
    if (settings.model !== previous.model) this.loadModel();
  }

  async run() {
    while (this.running) {
      let worked = false;
      if (this.modelReady) {
        try {
          worked = await this.pipeline.step();
        } catch (err) {
          if (!this.running) return;
          console.error('[subtítulos]', err);
          this.setStatus({ ...this.status, phase: 'error', message: `Fallo al reconocer el audio: ${err.message}` });
          await sleep(1000);
        }
      }
      if (!worked) await sleep(60);
    }
  }

  close() {
    this.running = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.playback?.close().catch(() => {});
    this.capture?.close().catch(() => {});
    this.worker?.terminate();
    for (const request of this.requests.values()) request.reject(new Error('captura detenida'));
    this.requests.clear();
  }
}

let session = null;

async function start({ streamId, settings }) {
  session?.close();
  session = new Session(settings);
  try {
    await session.open(streamId);
  } catch (err) {
    session.close();
    session = null;
    throw err;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;
  if (message.type === 'start') {
    start(message).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
    );
    return true;
  }
  if (message.type === 'stop') {
    session?.close();
    session = null;
    sendResponse({ ok: true });
  } else if (message.type === 'settings') {
    session?.applySettings(message.settings);
  } else if (message.type === 'new-page') {
    // La pestaña ha pasado a otra página (otro vídeo): puede estar en otro idioma.
    session?.pipeline.startOver();
  }
});
