// Flujo de subtítulos: audio → trozos de voz → reconocimiento → traducción → subtítulo.
//
// El audio se trocea por pausas (o a la fuerza, si nadie para de hablar), pero
// los trozos no coinciden con las frases. Para que la traducción sea coherente
// se traduce por frases: el texto que queda tras el último punto se guarda
// ("pendiente") y se une a lo siguiente que se reconozca.
//
// Cada subtítulo tiene un `id`. Mientras se habla se emiten versiones
// provisionales con ese id y, al cerrarse la frase, una final.
//
// Reconocer y traducir van por separado: el reconocimiento nunca espera a una
// traducción. Las traducciones se lanzan en paralelo (pocas a la vez) y los
// subtítulos se emiten siempre en el orden en que se reconocieron.
import { cleanTranscript, looksDegenerate } from './text.js';
import { LanguageTracker } from './langs.js';

// Idiomas que no separan las palabras con espacios.
const NO_SPACES = new Set(['zh', 'ja', 'th', 'yue', 'lo', 'km', 'my']);
// Final de frase: puntuación seguida de espacio o fin de texto (así "3.5" no
// corta), o puntuación china/japonesa, que no lleva espacio detrás.
const SENTENCE_END = /[.!?…]+["'»”’)\]]*(?=\s|$)|[。！？]+[」』）]*/g;

function join(pending, text, lang) {
  if (!pending) return text;
  return NO_SPACES.has(lang) ? pending + text : `${pending} ${text}`;
}

/** Parte el texto en lo que ya son frases completas y el resto. */
function splitAtLastSentenceEnd(text) {
  let end = 0;
  for (const match of text.matchAll(SENTENCE_END)) end = match.index + match[0].length;
  return { complete: text.slice(0, end).trim(), rest: text.slice(end).trim() };
}

export class CaptionPipeline {
  /**
   * @param {object} deps
   * @param {import('./segmenter.js').UtteranceSegmenter} deps.segmenter
   * @param {() => {sourceLang: string, targetLang: string}} deps.settings
   * @param {(audio: Float32Array, o: {language: string|null, sticky: string|null, locked: boolean}) => Promise<{text: string, lang: string, detected?: {lang: string, prob: number}}>} deps.transcribe
   * @param {(text: string, o: {source: string|null, target: string, final: boolean}) => Promise<{text: string, engine: string}>} deps.translate
   * @param {(caption: object) => void} deps.emit
   * @param {() => number} [deps.now]
   */
  constructor({ segmenter, settings, transcribe, translate, emit, now = () => Date.now(), options = {} }) {
    this.segmenter = segmenter;
    this.settings = settings;
    this.transcribe = transcribe;
    this.translate = translate;
    this.emit = emit;
    this.now = now;
    this.o = {
      sampleRate: 16000,
      minInterimMs: 800, // audio mínimo para un primer subtítulo provisional
      interimStepMs: 400, // crecimiento mínimo para repetir el reconocimiento
      maxBacklog: 2, // trozos en cola antes de saltarse los más antiguos
      pendingTimeoutMs: 1200, // sin más voz, lo pendiente se da por terminado
      maxPendingChars: 200, // tope de texto pendiente sin puntuación
      maxTranslations: 2, // traducciones en curso a la vez
      ...options,
    };
    this.queue = []; // trozos de voz terminados, a la espera de reconocerse
    this.rev = 0;
    this.languages = new LanguageTracker(); // idioma del audio (modo automático)
    this.interim = { id: null, samples: 0 }; // último trozo reconocido a medias

    this.captionId = 1; // subtítulo que se está construyendo
    this.shown = null; // texto original que ese subtítulo muestra ahora mismo
    this.pending = ''; // texto ya reconocido que aún no cierra frase
    this.pendingLang = null;
    this.pendingAt = 0;

    this.jobs = []; // versiones de subtítulo por traducir y emitir, en orden
    this.translating = 0;
    this.emitting = false;
  }

  /**
   * La pestaña ha pasado a otra página u otro vídeo: nada de lo anterior debe
   * mezclarse con lo nuevo. Se olvida el idioma del audio (uno asentado tarda,
   * a propósito, en cambiarse, y el vídeo nuevo puede estar en otro) y se
   * descarta el audio que quedaba por reconocer: si se reconociera ahora
   * volvería a fijar el idioma viejo. Lo que estaba a medias en pantalla se da
   * por terminado.
   */
  startOver() {
    this.languages = new LanguageTracker();
    this.queue = [];
    this.segmenter.reset();
    this.interim = { id: null, samples: 0 };
    this.#dropTentative();
    this.#closePending();
  }

  pushFrame(frame) {
    this.segmenter.push(frame);
    const finals = this.segmenter.takeFinals();
    if (finals.length) this.queue.push(...finals);
  }

  /** Hace una pasada de reconocimiento. Devuelve false si no había nada que hacer. */
  async step() {
    // Si el reconocimiento va con retraso, se saltan los trozos más antiguos.
    while (this.queue.length > this.o.maxBacklog) {
      this.queue.shift();
      this.#dropTentative();
    }
    if (this.queue.length) {
      await this.#process(this.queue.shift(), true);
      return true;
    }

    const current = this.segmenter.current();
    if (current) {
      const toSamples = (ms) => (ms / 1000) * this.o.sampleRate;
      const grown = current.id === this.interim.id ? current.audio.length - this.interim.samples : Infinity;
      if (current.audio.length >= toSamples(this.o.minInterimMs) && grown >= toSamples(this.o.interimStepMs)) {
        this.interim = { id: current.id, samples: current.audio.length };
        await this.#process(current, false);
        return true;
      }
      return false;
    }

    if (this.pending && this.now() - this.pendingAt >= this.o.pendingTimeoutMs) {
      this.#closePending();
      return true;
    }
    return false;
  }

  async #process(chunk, final) {
    const { sourceLang } = this.settings();
    const auto = !sourceLang || sourceLang === 'auto';
    const language = auto ? null : sourceLang;

    // Hay que medir el audio antes de entregarlo: el reconocedor se queda con él.
    const audioSeconds = chunk.audio.length / this.o.sampleRate;
    const heard = await this.transcribe(chunk.audio, {
      language,
      sticky: auto ? this.languages.current : null,
      // Con el idioma ya asentado, el reconocedor no debe cambiarlo por su cuenta.
      locked: auto && this.languages.established,
    });
    if (auto && looksDegenerate(heard.text)) this.languages.doubt();
    let text = cleanTranscript(heard.text);
    // Un trozo cortado a la fuerza (nadie hizo una pausa) acaba a mitad de
    // frase, pero Whisper suele ponerle punto final. Sin él, el texto se une
    // al del trozo siguiente y se traduce como la frase que es.
    if (final && chunk.forced) text = text.replace(/[.。]+$/u, '').trimEnd();
    if (!text) {
      if (final) this.#dropTentative();
      return;
    }
    if (auto) this.languages.observe(heard.detected ?? { lang: heard.lang, prob: 1 }, { audioSeconds, final });
    const lang = language ?? heard.lang ?? null;

    // Si cambia el idioma, lo pendiente no se mezcla con lo nuevo.
    if (this.pending && lang !== this.pendingLang) this.#closePending();

    const full = join(this.pending, text, lang);
    if (!final) {
      this.#show(full, lang, false);
      return;
    }

    const { complete, rest } = splitAtLastSentenceEnd(full);
    if (complete) this.#show(complete, lang, true);
    this.pending = rest;
    this.pendingLang = lang;
    this.pendingAt = this.now();
    if (rest.length > this.o.maxPendingChars) this.#closePending();
    else if (rest) this.#show(rest, lang, false);
  }

  /**
   * Da al subtítulo en construcción este texto; se emitirá, ya traducido,
   * cuando le toque. Una versión igual a la anterior también se emite: es la
   * señal de que el texto se ha estabilizado (quien pinta solo da por buena
   * una palabra cuando dos versiones seguidas coinciden en ella).
   */
  #show(original, lang, final) {
    this.#enqueue({ id: this.captionId, final, original, lang, target: this.settings().targetLang });
    if (final) {
      this.captionId++;
      this.shown = null;
    } else {
      this.shown = original;
    }
  }

  /** Da por terminado lo pendiente (ya estaba en pantalla como provisional). */
  #closePending() {
    const text = this.pending;
    this.pending = '';
    if (text) this.#show(text, this.pendingLang, true);
  }

  /**
   * El trozo que se estaba mostrando a medias al final no ha dado texto (o se
   * ha saltado): en pantalla debe quedar solo lo pendiente, o nada.
   */
  #dropTentative() {
    if (this.shown === null || this.shown === this.pending) return;
    if (this.pending) {
      this.#show(this.pending, this.pendingLang, false);
      return;
    }
    this.#enqueue({ id: this.captionId, final: true, original: '', lang: null, target: null });
    this.captionId++;
    this.shown = null;
  }

  // ---------- traducción y emisión, en paralelo al reconocimiento ----------

  #enqueue(job) {
    // Una versión provisional que aún espera turno queda obsoleta en cuanto
    // llega otra del mismo subtítulo: no merece la pena traducirla.
    const last = this.jobs.at(-1);
    if (last && !last.result && !last.final && last.id === job.id) this.jobs.pop();
    this.jobs.push(job);
    this.#pump();
  }

  #pump() {
    for (const job of this.jobs) {
      if (job.result) continue;
      if (this.translating >= this.o.maxTranslations) break;
      this.translating++;
      job.result = this.#translate(job).finally(() => {
        this.translating--;
        this.#pump();
      });
    }
    if (!this.emitting) this.#emitInOrder();
  }

  async #translate(job) {
    if (!job.original) return { text: '' };
    try {
      return await this.translate(job.original, { source: job.lang, target: job.target, final: job.final });
    } catch (err) {
      // El traductor puede saltarse una versión provisional (para no saturarse):
      // no pasa nada, ya vendrá otra. En cualquier otro fallo, mejor el texto
      // original que nada.
      if (!job.final && err?.code === 'skipped') return null;
      return { text: job.original, engine: 'error', error: err?.message ?? String(err) };
    }
  }

  async #emitInOrder() {
    this.emitting = true;
    while (this.jobs[0]?.result) {
      const job = this.jobs[0];
      const translated = await job.result;
      this.jobs.shift();
      if (!translated) continue;

      const caption = { id: job.id, rev: ++this.rev, final: job.final, text: translated.text, original: job.original };
      if (job.original) {
        caption.lang = job.lang;
        caption.engine = translated.engine;
        if (translated.error) caption.error = translated.error;
        if (translated.fallback) caption.fallback = translated.fallback;
      }
      this.emit(caption);
    }
    this.emitting = false;
  }
}
