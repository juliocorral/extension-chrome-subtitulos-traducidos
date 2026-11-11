// Barra de subtítulos que se inyecta en la pestaña capturada. Se muestra por
// encima de la página (también a pantalla completa), se arrastra con el ratón
// y lleva sus propios ajustes de idioma, color, fuente y tamaño.
//
// El texto se pinta como los subtítulos automáticos de YouTube: las palabras
// aparecen de una en una en la línea de abajo; al llenarse, la línea sube y la
// de arriba desaparece. Lo ya escrito no se recoloca (ver shared/rollup.js).
(() => {
  if (globalThis.__ltSubtitles) {
    globalThis.__ltSubtitles.mount();
    return;
  }

  const LT = globalThis.LT;
  const CLEAR_AFTER_MS = 5000; // sin palabras nuevas, los subtítulos se retiran
  const EDGE = 6; // margen mínimo con el borde de la ventana
  const LINE_HEIGHT = 1.32; // en em; el mismo valor está en el CSS
  const LINE_PADDING = 0.3; // relleno lateral de cada línea, en em
  const ROLL_MS = 180; // lo que tarda una línea en subir

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .lt-bar {
      --lt-ui-text: #f1f3f5;
      --lt-ui-muted: #b4bcc5;
      --lt-ui-field: rgb(255 255 255 / 0.09);
      --lt-ui-line: rgb(255 255 255 / 0.24);
      --lt-ui-accent: #ffe14d;
      --lt-ui-focus: #ffe14d;
      position: absolute;
      left: calc(var(--lt-x) * 100%);
      bottom: calc((1 - var(--lt-y)) * 100%);
      transform: translateX(-50%);
      /* Ancho fijo (unas 48 letras): las líneas nacen siempre en el mismo borde
         izquierdo y crecen hacia la derecha, así el texto no se mueve al leerlo. */
      width: min(92%, calc(var(--lt-size) * 24));
      /* La barra en sí no intercepta el ratón: solo el texto y los controles. */
      pointer-events: none;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: var(--lt-ui-text);
      outline: none;
    }
    .lt-line, .lt-status, .lt-original-clip { pointer-events: auto; cursor: grab; }
    .lt-bar.lt-dragging :is(.lt-line, .lt-status, .lt-original-clip) { cursor: grabbing; }
    .lt-bar:focus-visible .lt-box { outline: 2px solid var(--lt-ui-focus); outline-offset: 3px; }

    .lt-box {
      font-family: var(--lt-font);
      font-size: var(--lt-size);
      line-height: ${LINE_HEIGHT};
      color: var(--lt-color);
      text-shadow: 0 0 0.08em #000, 0 0.05em 0.14em rgb(0 0 0 / 0.9);
    }

    /* Las líneas: cada una con su fondo ceñido al texto, alineadas a la izquierda. */
    .lt-text {
      display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-end;
      max-height: calc(var(--lt-lines) * ${LINE_HEIGHT}em);
      overflow: hidden;
    }
    .lt-line {
      flex: none; max-width: 100%; height: ${LINE_HEIGHT}em; padding: 0 ${LINE_PADDING}em;
      overflow: hidden; white-space: nowrap;
      background: rgb(8 8 8 / var(--lt-alpha));
    }
    .lt-original-clip {
      display: flex; justify-content: flex-end; width: fit-content; max-width: 100%;
      padding: 0 ${LINE_PADDING / 0.62}em; overflow: hidden; white-space: nowrap;
      font-size: 0.62em; opacity: 0.85;
      background: rgb(8 8 8 / var(--lt-alpha));
    }
    .lt-original { flex: none; }

    @media (prefers-reduced-motion: no-preference) {
      /* La línea nueva crece desde abajo y empuja a las demás: la de arriba
         va saliendo por el borde superior. */
      .lt-line.lt-enter { animation: lt-roll ${ROLL_MS}ms ease-out; }
      /* Cada palabra entra con un fundido breve para distinguir lo nuevo. */
      .lt-word.lt-new { animation: lt-in 200ms ease-out; }
      .lt-bar[data-phase="loading-model"] .lt-dot, .lt-bar[data-phase="starting"] .lt-dot {
        animation: lt-pulse 1.1s ease-in-out infinite alternate;
      }
    }
    @keyframes lt-roll { from { height: 0; } }
    @keyframes lt-in { from { opacity: 0.1; } }
    @keyframes lt-pulse { from { opacity: 0.35; } to { opacity: 1; } }

    .lt-status {
      display: flex; align-items: center; gap: 0.5em; width: fit-content; max-width: 100%;
      padding: 0.3em 0.75em;
      border-radius: 0.3em;
      background: rgb(8 8 8 / var(--lt-alpha));
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: clamp(12px, calc(var(--lt-size) * 0.5), 18px);
      color: #fff;
    }
    /* Aviso de que no se está pudiendo traducir (se ve el texto original). */
    .lt-warning {
      display: flex; align-items: center; gap: 10px; width: fit-content; max-width: 100%;
      margin-top: 4px; padding: 4px 6px 4px 10px;
      border-left: 3px solid #ffe14d; border-radius: 4px;
      background: rgb(8 8 8 / 0.92);
      font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
      pointer-events: auto; cursor: grab;
    }
    .lt-warning button {
      flex: none; padding: 3px 8px; border: 1px solid rgb(255 255 255 / 0.3); border-radius: 4px;
      background: transparent; color: #ffe14d; font: inherit; cursor: pointer;
    }
    .lt-warning button:hover { background: rgb(255 255 255 / 0.1); }
    .lt-warning button:focus-visible { outline: 2px solid var(--lt-ui-focus); outline-offset: 2px; }
    .lt-dot { flex: none; width: 0.55em; height: 0.55em; border-radius: 50%; background: #ffe14d; }
    .lt-bar[data-phase="listening"] .lt-dot { background: #5ce1e6; }
    .lt-bar[data-phase="error"] .lt-dot { background: #ff6b6b; }

    /* Botones que aparecen al pasar el ratón por el texto. */
    .lt-tools {
      position: absolute; left: 0; bottom: 100%;
      display: flex; gap: 4px; padding-bottom: 6px;
      opacity: 0; pointer-events: none; transition: opacity 0.12s;
    }
    .lt-bar.lt-flip .lt-tools { bottom: auto; top: 100%; padding: 6px 0 0; }
    .lt-bar:hover .lt-tools, .lt-bar:focus-within .lt-tools, .lt-bar.lt-open .lt-tools {
      opacity: 1; pointer-events: auto;
    }
    .lt-bar.lt-dragging .lt-tools { opacity: 0; }
    .lt-tools button {
      display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
      border: 1px solid rgb(255 255 255 / 0.18); border-radius: 50%;
      background: rgb(20 23 26 / 0.92); color: #fff; cursor: pointer;
    }
    .lt-tools button:hover, .lt-tools button[aria-expanded="true"] { background: #2d333a; }
    .lt-tools button:focus-visible { outline: 2px solid var(--lt-ui-focus); outline-offset: 2px; }
    .lt-tools svg { width: 15px; height: 15px; }

    .lt-panel {
      position: absolute; left: 146px; bottom: calc(100% + 40px);
      transform: translateX(calc(-50% + var(--lt-panel-shift, 0px)));
      width: 292px; padding: 14px 16px 12px;
      background: rgb(24 27 31 / 0.97); border: 1px solid rgb(255 255 255 / 0.14); border-radius: 12px;
      box-shadow: 0 14px 44px rgb(0 0 0 / 0.55);
      pointer-events: auto; cursor: default; text-align: left;
    }
    .lt-bar.lt-flip .lt-panel { bottom: auto; top: calc(100% + 40px); }
    .lt-panel-note { margin: 12px 0 0; font-size: 12px; color: var(--lt-ui-muted); }
    ${LT.FORM_CSS}
    .lt-form select { color-scheme: dark; }
  `;

  // Estilos añadidos dentro de la ventana flotante (Document Picture-in-Picture).
  const FLOATING_CSS = `
    html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
    .lt-bar.lt-floating {
      position: static; transform: none; display: flex; flex-direction: column; justify-content: center;
      width: 100%; height: 100%; padding: 6px 12px;
    }
    .lt-floating :is(.lt-line, .lt-status, .lt-original-clip) { padding-inline: 0; background: transparent; cursor: default; }
  `;

  const ICON_SETTINGS =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 4.5h7M13 4.5h1M2 11.5h1M7 11.5h7"/><circle cx="11" cy="4.5" r="1.9"/><circle cx="5" cy="11.5" r="1.9"/></svg>';
  const ICON_FLOAT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.6"/><rect x="8" y="7.6" width="4.6" height="3.4" rx="0.6" fill="currentColor" stroke="none"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  let host = null;
  let el = null;
  let form = null;
  let settings = { ...LT.DEFAULTS };
  let status = { phase: 'starting' };
  let position = { ...LT.DEFAULTS.position };
  let original = ''; // texto original de la frase en curso
  let clearTimer = null;
  let drag = null;
  let resizeObserver = null;
  let floating = null; // { window, wrapper } mientras los subtítulos están en la ventana flotante

  const ruler = document.createElement('canvas').getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const rollup = new LT.RollUp({
    maxLines: settings.maxLines,
    maxWidth: settings.fontSize * 24,
    measure(text) {
      ruler.font = `${settings.fontSize}px ${LT.fontCss(settings.fontFamily)}`;
      return ruler.measureText(text).width;
    },
  });
  const revealer = new LT.Revealer({ onWord: showWord });

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      // La extensión se ha recargado o desinstalado: esta barra ya no sirve.
      unmount();
      return Promise.resolve(null);
    }
  }

  function save(patch) {
    try {
      chrome.storage.local.set(patch);
    } catch {
      unmount();
    }
  }

  function statusLabel() {
    switch (status.phase) {
      case 'listening':
        return 'Escuchando…';
      case 'loading-model':
        return status.progress != null && status.progress < 100
          ? `Descargando el modelo de voz… ${status.progress} %`
          : 'Cargando el modelo de voz…';
      case 'error':
        return status.message || 'Algo ha fallado';
      default:
        return 'Preparando los subtítulos…';
    }
  }

  function build() {
    host = document.createElement('lt-subtitles');
    // "popover" coloca la barra en la capa superior del navegador, por encima
    // de cualquier z-index de la página y del vídeo a pantalla completa.
    host.setAttribute('popover', 'manual');
    host.style.cssText = [
      'all: initial',
      'display: block',
      'position: fixed',
      'inset: 0',
      'width: 100%',
      'height: 100%',
      'margin: 0',
      'padding: 0',
      'border: 0',
      'background: transparent',
      'overflow: visible',
      'pointer-events: none',
      'z-index: 2147483647',
    ]
      .map((rule) => `${rule} !important`)
      .join(';');

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="lt-bar" tabindex="0" role="group" aria-label="Subtítulos traducidos. Arrastra para mover la barra." data-phase="starting">
        <div class="lt-tools">
          <button type="button" class="lt-float-button" aria-pressed="false">${ICON_FLOAT}</button>
          <button type="button" class="lt-settings-button" aria-label="Ajustes de los subtítulos" title="Ajustes" aria-expanded="false">${ICON_SETTINGS}</button>
          <button type="button" class="lt-stop-button" aria-label="Detener la traducción" title="Detener">${ICON_CLOSE}</button>
        </div>
        <div class="lt-panel" hidden></div>
        <div class="lt-box lt-away" hidden>
          <div class="lt-status"><span class="lt-dot"></span><span>Subtítulos en la ventana flotante</span></div>
        </div>
        <div class="lt-box lt-main">
          <div class="lt-caption" hidden>
            <div class="lt-original-clip" hidden><div class="lt-original" dir="auto"></div></div>
            <div class="lt-text"></div>
          </div>
          <div class="lt-status"><span class="lt-dot"></span><span class="lt-status-text"></span></div>
        </div>
        <div class="lt-warning" hidden>
          <span>No se puede traducir ahora mismo: se muestra lo que se dice, sin traducir.</span>
          <button type="button">Ver cómo arreglarlo</button>
        </div>
      </div>`;

    const $ = (selector) => root.querySelector(selector);
    el = {
      bar: $('.lt-bar'),
      box: $('.lt-main'),
      away: $('.lt-away'),
      floatButton: $('.lt-float-button'),
      panel: $('.lt-panel'),
      caption: $('.lt-caption'),
      originalClip: $('.lt-original-clip'),
      original: $('.lt-original'),
      text: $('.lt-text'),
      // Dentro de .lt-main: el aviso de ventana flotante tiene su propia fila de estado.
      status: $('.lt-main .lt-status'),
      statusText: $('.lt-main .lt-status-text'),
      settingsButton: $('.lt-settings-button'),
      stopButton: $('.lt-stop-button'),
      warning: $('.lt-warning'),
    };

    form = LT.createSettingsForm({
      fields: ['targetLang', 'textColor', 'fontFamily', 'fontSize', 'bgOpacity'],
      onChange: save,
    });
    const note = document.createElement('p');
    note.className = 'lt-panel-note';
    note.textContent = 'Hay más opciones en el icono de la extensión.';
    el.panel.append(form.element, note);

    el.settingsButton.addEventListener('click', () => togglePanel());
    // La ventana flotante solo existe en páginas seguras y en el marco principal.
    el.floatButton.hidden = !('documentPictureInPicture' in window);
    el.floatButton.addEventListener('click', () => (floating ? closeFloating() : openFloating()));
    labelFloatButton();
    el.stopButton.addEventListener('click', () => send({ type: 'lt:stop' }));
    // El popup explica qué pasa y, si hace falta, descarga el traductor local.
    el.warning.querySelector('button').addEventListener('click', () => send({ type: 'lt:open-popup' }));

    el.bar.addEventListener('pointerdown', onPointerDown);
    el.bar.addEventListener('pointermove', onPointerMove);
    el.bar.addEventListener('pointerup', onPointerUp);
    el.bar.addEventListener('pointercancel', onPointerUp);
    el.bar.addEventListener('keydown', onKeyDown);

    // Que las teclas pulsadas en la barra no disparen atajos de la página (YouTube, etc.).
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  // ---------- posición y arrastre ----------

  function applyPosition() {
    if (!host?.isConnected) return;
    const view = host.getBoundingClientRect();
    const bar = el.bar.getBoundingClientRect();
    if (!view.width || !view.height) return;
    const half = bar.width / 2 + EDGE;
    const x = clamp(position.x, half / view.width, 1 - half / view.width);
    const y = clamp(position.y, (bar.height + EDGE) / view.height, 1 - EDGE / view.height);
    el.bar.style.setProperty('--lt-x', x);
    el.bar.style.setProperty('--lt-y', y);

    // Si no cabe encima, los botones y el panel van debajo.
    const top = y * view.height - bar.height;
    const needed = el.panel.hidden ? 40 : el.panel.offsetHeight + 48;
    el.bar.classList.toggle('lt-flip', top < needed);
    if (!el.panel.hidden) {
      // El panel cuelga del borde izquierdo de la barra; si se sale de la ventana, se corre.
      const centre = x * view.width - bar.width / 2 + el.panel.offsetWidth / 2;
      const halfPanel = el.panel.offsetWidth / 2 + EDGE;
      const shift = clamp(centre, halfPanel, view.width - halfPanel) - centre;
      el.panel.style.setProperty('--lt-panel-shift', `${shift}px`);
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.target.closest('.lt-panel, .lt-tools, button')) return;
    const bar = el.bar.getBoundingClientRect();
    drag = {
      pointer: event.pointerId,
      dx: event.clientX - (bar.left + bar.width / 2),
      dy: event.clientY - bar.bottom,
      moved: false,
    };
    el.bar.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const view = host.getBoundingClientRect();
    position = {
      x: (event.clientX - drag.dx - view.left) / view.width,
      y: (event.clientY - drag.dy - view.top) / view.height,
    };
    drag.moved = true;
    el.bar.classList.add('lt-dragging');
    applyPosition();
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const moved = drag.moved;
    drag = null;
    el.bar.classList.remove('lt-dragging');
    if (moved) commitPosition();
  }

  /** Guarda la posición tal y como ha quedado en pantalla (ya recortada a la ventana). */
  function commitPosition() {
    position = {
      x: Number(el.bar.style.getPropertyValue('--lt-x')),
      y: Number(el.bar.style.getPropertyValue('--lt-y')),
    };
    save({ position });
  }

  function onKeyDown(event) {
    if (event.target !== el.bar) {
      if (event.key === 'Escape' && !el.panel.hidden) {
        togglePanel(false);
        el.settingsButton.focus();
      }
      return;
    }
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    position = { x: position.x + move[0], y: position.y + move[1] };
    applyPosition();
    commitPosition();
  }

  // ---------- ajustes ----------

  function togglePanel(open = el.panel.hidden) {
    el.panel.hidden = !open;
    el.bar.classList.toggle('lt-open', open);
    el.settingsButton.setAttribute('aria-expanded', String(open));
    applyPosition();
  }

  function onOutsidePointer(event) {
    if (!host || el.panel.hidden) return;
    if (!event.composedPath().includes(host)) togglePanel(false);
  }

  function applySettings() {
    for (const target of [el.bar, floating?.wrapper]) {
      if (!target) continue;
      target.style.setProperty('--lt-color', settings.textColor);
      target.style.setProperty('--lt-font', LT.fontCss(settings.fontFamily));
      target.style.setProperty('--lt-size', `${settings.fontSize}px`);
      target.style.setProperty('--lt-alpha', settings.bgOpacity / 100);
    }
    form.update(settings);
    if (!drag) position = { ...LT.DEFAULTS.position, ...settings.position };
    relayout();
    render();
  }

  // ---------- subtítulos ----------

  /** Espacio disponible: cuántas líneas caben y cuánto mide cada una. */
  function metrics() {
    const lineHeight = settings.fontSize * LINE_HEIGHT;
    if (floating) {
      const extra = settings.showOriginal ? lineHeight * 0.62 : 0;
      return {
        maxLines: Math.max(1, Math.floor((floating.window.innerHeight - 12 - extra) / lineHeight)),
        maxWidth: Math.max(80, floating.window.innerWidth - 24),
      };
    }
    const barWidth = el.bar.getBoundingClientRect().width || settings.fontSize * 24;
    return {
      maxLines: settings.maxLines,
      maxWidth: Math.max(80, barWidth - 2 * LINE_PADDING * settings.fontSize),
    };
  }

  // Lo último con lo que se colocó el texto: si no cambia, no hay que recolocar.
  let laidOutWith = '';

  /** Recoloca el texto visible si ha cambiado el ancho, las líneas o la fuente. */
  function relayout() {
    if (!el) return;
    const { maxLines, maxWidth } = metrics();
    for (const target of [el.bar, floating?.wrapper]) target?.style.setProperty('--lt-lines', maxLines);
    // Se deja un 2 % de holgura: el lienzo y la página pueden medir distinto por décimas.
    const signature = [maxLines, Math.floor(maxWidth), settings.fontSize, settings.fontFamily].join('|');
    if (signature === laidOutWith) return;
    laidOutWith = signature;
    rollup.resize({ maxLines, maxWidth: maxWidth * 0.98 });
    drawLines(false);
  }

  /** Pone el DOM de acuerdo con las líneas de `rollup`, añadiendo solo lo que falta. */
  function drawLines(animate) {
    const moving = animate && !reducedMotion.matches;
    const wanted = new Map(rollup.lines.map((line) => [String(line.id), line]));
    const drawn = new Map();
    for (const node of el.text.querySelectorAll('.lt-line:not(.lt-leaving)')) {
      if (wanted.has(node.dataset.line)) {
        drawn.set(node.dataset.line, node);
      } else if (moving) {
        // Sigue ahí mientras la línea nueva la empuja fuera del recorte.
        node.classList.add('lt-leaving');
        setTimeout(() => node.remove(), ROLL_MS + 40);
      } else {
        node.remove();
      }
    }
    for (const [id, line] of wanted) {
      let node = drawn.get(id);
      if (!node) {
        node = document.createElement('div');
        node.className = moving ? 'lt-line lt-enter' : 'lt-line';
        node.dataset.line = id;
        node.dir = 'auto';
        el.text.append(node);
      }
      for (let i = node.childElementCount; i < line.words.length; i++) {
        const word = document.createElement('span');
        word.className = moving ? 'lt-word lt-new' : 'lt-word';
        word.textContent = line.words[i];
        if (i > 0 && rollup.spaced) node.append(' ');
        node.append(word);
      }
    }
  }

  /** Una palabra nueva llega a la pantalla. */
  function showWord(word) {
    if (!el) return;
    if (word.spaced !== rollup.spaced) {
      rollup.resize({ spaced: word.spaced });
      drawLines(false);
    }
    rollup.add(word);
    drawLines(true);
    render();
    clearTimeout(clearTimer);
    clearTimer = setTimeout(clearCaptions, CLEAR_AFTER_MS);
  }

  function clearCaptions() {
    clearTimeout(clearTimer);
    revealer.stop();
    rollup.clear();
    original = '';
    el?.text.replaceChildren();
    render();
  }

  function render() {
    if (!el) return;
    const visible = rollup.lines.length > 0;
    const showOriginal = visible && settings.showOriginal && original.length > 0;
    el.original.textContent = showOriginal ? original : '';
    el.originalClip.hidden = !showOriginal;
    el.caption.hidden = !visible;
    el.status.hidden = visible;
    el.statusText.textContent = statusLabel();
    el.warning.hidden = !(status.phase === 'listening' && status.translator?.engine === 'error');
    el.bar.dataset.phase = status.phase;
    if (floating) floating.wrapper.dataset.phase = status.phase;
    applyPosition();
  }

  function onCaption(caption) {
    if (!Array.isArray(caption?.words)) return;
    original = caption.original ?? '';
    if (caption.words.length) {
      revealer.enqueue(caption.words.map((word) => ({ ...word, spaced: caption.spaced !== false })));
    }
    render();
  }

  // ---------- ventana flotante ----------

  function labelFloatButton() {
    const label = floating ? 'Devolver los subtítulos a la página' : 'Sacar los subtítulos a una ventana flotante';
    el.floatButton.title = floating ? 'Devolver a la página' : 'Ventana flotante';
    el.floatButton.setAttribute('aria-label', label);
    el.floatButton.setAttribute('aria-pressed', String(Boolean(floating)));
  }

  /**
   * Saca los subtítulos a una ventana siempre visible que se puede llevar a
   * cualquier parte de la pantalla, también fuera del navegador.
   */
  async function openFloating() {
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({
        width: Math.round(Math.min(screen.availWidth * 0.7, settings.fontSize * 24 + 24)),
        height: Math.round(settings.fontSize * LINE_HEIGHT * settings.maxLines + 40),
      });
    } catch (err) {
      console.warn('[subtítulos] no se pudo abrir la ventana flotante:', err);
      return;
    }
    const doc = win.document;
    doc.title = 'Subtítulos traducidos';
    const style = doc.createElement('style');
    style.textContent = CSS + FLOATING_CSS;
    const wrapper = doc.createElement('div');
    wrapper.className = 'lt-bar lt-floating';
    doc.head.append(style);
    doc.body.append(wrapper);
    wrapper.append(el.box);

    floating = { window: win, wrapper };
    el.away.hidden = false;
    win.addEventListener('pagehide', () => closeFloating(true), { once: true });
    win.addEventListener('resize', relayout);
    labelFloatButton();
    applySettings();
  }

  function closeFloating(alreadyClosing = false) {
    if (!floating) return;
    const { window: win } = floating;
    floating = null;
    el.bar.append(el.box);
    el.away.hidden = true;
    if (!alreadyClosing) win.close();
    labelFloatButton();
    relayout();
    render();
  }

  // ---------- ciclo de vida ----------

  function show() {
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      // Sin popover la barra sigue funcionando con su z-index.
    }
  }

  /**
   * Coloca la barra en el documento. Cuando hay algo a pantalla completa,
   * Chrome deja inerte todo lo que no cuelgue de ese elemento: la barra se
   * vería pero no respondería al ratón. Por eso se muda dentro de él (si es
   * un contenedor que pinta a sus hijos) y vuelve a su sitio al salir.
   */
  function place() {
    const fullscreen = document.fullscreenElement;
    const root = document.documentElement;
    let parent = root;
    if (fullscreen && !/^(VIDEO|AUDIO|IFRAME|CANVAS|IMG|EMBED|OBJECT)$/.test(fullscreen.tagName)) {
      parent = fullscreen;
    }
    if (host.parentNode !== parent) parent.append(host);
    show();
    // Si ese elemento no pinta a sus hijos (p. ej. un componente sin <slot>),
    // mejor visible sin ratón que invisible.
    if (parent !== root && host.getBoundingClientRect().width === 0) {
      root.append(host);
      show();
    }
    applyPosition();
  }

  function mount() {
    if (host?.isConnected) return;
    if (!host) build();
    place();
    resizeObserver = new ResizeObserver((entries) => {
      // Si cambia la ventana cambia el ancho de línea disponible.
      if (entries.some((entry) => entry.target === host)) relayout();
      applyPosition();
    });
    resizeObserver.observe(el.bar);
    resizeObserver.observe(host);
    document.addEventListener('fullscreenchange', place);
    document.addEventListener('pointerdown', onOutsidePointer, true);

    chrome.storage.local.get(LT.DEFAULTS).then((stored) => {
      settings = stored;
      applySettings();
    });
    send({ type: 'lt:overlay-ready' }).then((reply) => {
      if (!reply) return;
      if (!reply.active) return unmount();
      status = reply.status ?? status;
      render();
    });
    render();
  }

  function unmount() {
    closeFloating();
    clearCaptions();
    resizeObserver?.disconnect();
    document.removeEventListener('fullscreenchange', place);
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    host?.remove();
    if (el) togglePanel(false);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'lt:remove') return unmount();
    if (message?.type !== 'lt:caption' && message?.type !== 'lt:status') return;
    if (!host?.isConnected) mount(); // la página puede haber retirado la barra
    if (message.type === 'lt:caption') onCaption(message.caption);
    else {
      status = message.status;
      render();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !host?.isConnected) return;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue ?? LT.DEFAULTS[key];
    }
    applySettings();
  });

  globalThis.__ltSubtitles = { mount };
  mount();
})();
