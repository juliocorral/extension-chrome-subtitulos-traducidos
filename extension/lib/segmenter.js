// Trocea el audio continuo en frases: abre una frase cuando detecta voz y la
// cierra tras una pausa. Si nadie hace pausas, fuerza un corte en el momento
// más flojo de los últimos segundos para que los subtítulos no se retrasen.

export function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
}

function concat(frames) {
  let length = 0;
  for (const f of frames) length += f.data.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const f of frames) {
    out.set(f.data, offset);
    offset += f.data.length;
  }
  return out;
}

export class UtteranceSegmenter {
  constructor(options = {}) {
    const o = {
      frameMs: 100, // duración de cada trama que llega a push()
      // Pausa que da la frase por terminada. Depende de cuánto se lleve
      // hablado: a una frase breve se le da más margen (los trozos sueltos se
      // reconocen y traducen peor) y una larga se cierra en cuanto hay un respiro.
      endSilenceMs: 600,
      shortUtteranceMs: 2500,
      endSilenceShortMs: 1000,
      longUtteranceMs: 6000,
      endSilenceLongMs: 400,
      trailMs: 300, // silencio final que se conserva al cerrar la frase
      maxUtteranceMs: 9000, // a partir de aquí se fuerza un corte
      splitSearchMs: 3000, // tramo final donde se busca el punto de corte
      preRollMs: 300, // audio previo a la voz que se conserva
      minSpeechMs: 200, // por debajo de esto es un chasquido, no una frase
      // Umbral de voz. Se adapta al audio, porque el nivel que llega depende
      // del volumen del reproductor: la voz debe superar el ruido de fondo
      // (el mínimo de los últimos segundos) en un factor, pero nunca se exige
      // más que una fracción del nivel más alto reciente. Sin ese tope, una
      // voz floja y de nivel parejo acababa pasando por ruido de fondo.
      levelWindowMs: 20000, // ventana en la que se miran el mínimo y el máximo
      floorRatio: 2.5,
      peakRatio: 0.35,
      minThreshold: 0.002,
      maxThreshold: 0.04,
      ...options,
    };
    this.o = o;
    this.preRollFrames = Math.round(o.preRollMs / o.frameMs);
    this.levelFrames = Math.round(o.levelWindowMs / o.frameMs);
    this.levels = [];
    this.preRoll = [];
    this.open = null;
    this.finals = [];
    this.nextId = 1;
  }

  push(data) {
    const level = rms(data);
    this.levels.push(level);
    if (this.levels.length > this.levelFrames) this.levels.shift();
    const floor = Math.min(...this.levels);
    const peak = Math.max(...this.levels);
    const threshold = Math.max(
      this.o.minThreshold,
      Math.min(floor * this.o.floorRatio, peak * this.o.peakRatio, this.o.maxThreshold),
    );
    const frame = { data, level, speech: level > threshold };

    if (!this.open) {
      if (frame.speech) {
        this.open = { id: this.nextId++, frames: [...this.preRoll, frame], speech: 1, silence: 0 };
        this.preRoll = [];
      } else {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      }
      return;
    }

    const utt = this.open;
    utt.frames.push(frame);
    if (frame.speech) {
      utt.speech++;
      utt.silence = 0;
    } else {
      utt.silence++;
    }

    if (utt.silence * this.o.frameMs >= this.#endSilenceMs(utt)) {
      const excess = Math.max(0, utt.silence - Math.round(this.o.trailMs / this.o.frameMs));
      this.#close(utt, utt.frames.slice(0, utt.frames.length - excess));
      this.preRoll = utt.frames.slice(-this.preRollFrames);
      this.open = null;
    } else if (utt.frames.length * this.o.frameMs >= this.o.maxUtteranceMs) {
      this.#forceSplit(utt);
    }
  }

  /** Descarta la frase en curso y las terminadas sin entregar (el audio pasa a ser otro). */
  reset() {
    this.open = null;
    this.preRoll = [];
    this.finals = [];
  }

  /** Frases terminadas desde la última llamada: [{ id, audio, forced }]. */
  takeFinals() {
    const out = this.finals;
    this.finals = [];
    return out;
  }

  /** Frase en curso (copia del audio acumulado) o null si no hay voz. */
  current() {
    const utt = this.open;
    if (!utt || utt.speech * this.o.frameMs < this.o.minSpeechMs) return null;
    return { id: utt.id, audio: concat(utt.frames) };
  }

  #endSilenceMs(utt) {
    const spoken = utt.speech * this.o.frameMs;
    if (spoken < this.o.shortUtteranceMs) return this.o.endSilenceShortMs;
    if (spoken >= this.o.longUtteranceMs) return this.o.endSilenceLongMs;
    return this.o.endSilenceMs;
  }

  /** `forced`: la frase no acabó en una pausa, se cortó por larga. */
  #close(utt, frames, forced = false) {
    const speech = frames.reduce((n, f) => n + (f.speech ? 1 : 0), 0);
    if (speech * this.o.frameMs >= this.o.minSpeechMs) {
      this.finals.push({ id: utt.id, audio: concat(frames), forced });
    }
  }

  #forceSplit(utt) {
    const searchFrames = Math.round(this.o.splitSearchMs / this.o.frameMs);
    const start = Math.max(0, utt.frames.length - searchFrames);
    let cut = start;
    for (let i = start; i < utt.frames.length; i++) {
      if (utt.frames[i].level < utt.frames[cut].level) cut = i;
    }
    this.#close(utt, utt.frames.slice(0, cut + 1), true);
    const rest = utt.frames.slice(cut + 1);
    if (rest.length === 0) {
      this.open = null;
      return;
    }
    let silence = 0;
    for (let i = rest.length - 1; i >= 0 && !rest[i].speech; i--) silence++;
    this.open = {
      id: this.nextId++,
      frames: rest,
      speech: rest.reduce((n, f) => n + (f.speech ? 1 : 0), 0),
      silence,
    };
  }
}
