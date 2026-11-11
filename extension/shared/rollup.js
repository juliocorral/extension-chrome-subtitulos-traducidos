// Cómo se pintan los subtítulos, al estilo de YouTube: las palabras aparecen
// de una en una en la línea de abajo; cuando no caben más, la línea sube, se
// abre otra debajo y la de arriba desaparece. Lo ya escrito no se recoloca.
//
// Es un script clásico (se inyecta en la página junto a la barra) que añade
// sus piezas a globalThis.LT. No toca el DOM: de eso se encarga la barra.
(() => {
  const LT = (globalThis.LT ??= {});

  /** Reparte las palabras en líneas que solo crecen por la derecha. */
  class RollUp {
    /**
     * @param {object} options
     * @param {number} options.maxLines  Líneas visibles a la vez.
     * @param {number} options.maxWidth  Ancho de línea, en lo que mida `measure`.
     * @param {(text: string) => number} options.measure
     * @param {boolean} [options.spaced]  false en idiomas sin espacios entre palabras.
     */
    constructor({ maxLines = 2, maxWidth, measure, spaced = true }) {
      this.maxLines = maxLines;
      this.maxWidth = maxWidth;
      this.measure = measure;
      this.spaced = spaced;
      this.lines = []; // [{ id, words: string[], starts: boolean[] }], de arriba abajo
      this.nextId = 1;
    }

    get separator() {
      return this.spaced ? ' ' : '';
    }

    /** Añade una palabra. Devuelve la línea donde ha quedado y si es nueva. */
    add({ text, sentenceStart = false }) {
      const current = this.lines.at(-1);
      let newLine = !current;
      if (current) {
        const now = this.measure(current.words.join(this.separator));
        const after = this.measure([...current.words, text].join(this.separator));
        // Una frase nueva estrena línea si la actual ya va por la mitad: así
        // no se mezcla con el final de la anterior.
        newLine = after > this.maxWidth || (sentenceStart && now >= this.maxWidth / 2);
      }
      if (newLine) {
        this.lines.push({ id: this.nextId++, words: [], starts: [] });
        while (this.lines.length > this.maxLines) this.lines.shift();
      }
      const line = this.lines.at(-1);
      line.words.push(text);
      line.starts.push(sentenceStart);
      return { line, newLine };
    }

    clear() {
      this.lines = [];
    }

    /** Recoloca el texto visible con otro ancho, número de líneas o separación. */
    resize({ maxWidth = this.maxWidth, maxLines = this.maxLines, spaced = this.spaced } = {}) {
      const words = this.lines.flatMap((line) =>
        line.words.map((text, i) => ({ text, sentenceStart: line.starts[i] })),
      );
      Object.assign(this, { maxWidth, maxLines, spaced, lines: [] });
      for (const word of words) this.add(word);
    }
  }

  /** Milisegundos entre una palabra y la siguiente según cuántas esperan. */
  function revealDelay(waiting) {
    return Math.min(120, Math.max(40, Math.round(480 / Math.max(1, waiting))));
  }

  // Con la pestaña en segundo plano Chrome frena los temporizadores y las
  // palabras se acumulan; al volver no tiene sentido repasarlas todas.
  const MAX_WAITING = 40;

  /** Entrega las palabras de una en una, con una pequeña pausa entre ellas. */
  class Revealer {
    constructor({
      onWord,
      setTimeout: schedule = (fn, ms) => setTimeout(fn, ms),
      clearTimeout: cancel = (id) => clearTimeout(id),
    }) {
      this.onWord = onWord;
      this.schedule = schedule;
      this.cancel = cancel;
      this.waiting = [];
      this.timer = null; // pendiente mientras no toca mostrar la siguiente
    }

    enqueue(words) {
      this.waiting.push(...words);
      if (this.waiting.length > MAX_WAITING) this.waiting.splice(0, this.waiting.length - MAX_WAITING);
      if (this.timer === null) this.#next();
    }

    stop() {
      this.waiting = [];
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null;
    }

    #next() {
      this.timer = null;
      const word = this.waiting.shift();
      if (!word) return;
      // El temporizador se arma siempre, aunque no quede nada: es lo que
      // impide que la siguiente palabra salga pegada a esta.
      this.timer = this.schedule(() => this.#next(), revealDelay(this.waiting.length));
      this.onWord(word);
    }
  }

  Object.assign(LT, { RollUp, Revealer, revealDelay });
})();
