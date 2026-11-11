// Configuración compartida por todas las partes de la extensión (service
// worker, documento offscreen, popup y barra de subtítulos). Es un script
// clásico para poder inyectarlo también como content script.
(() => {
  const LANGUAGES = [
    { code: 'es', name: 'Español' },
    { code: 'en', name: 'Inglés' },
    { code: 'fr', name: 'Francés' },
    { code: 'de', name: 'Alemán' },
    { code: 'it', name: 'Italiano' },
    { code: 'pt', name: 'Portugués' },
    { code: 'ca', name: 'Catalán' },
    { code: 'gl', name: 'Gallego' },
    { code: 'eu', name: 'Euskera' },
    { code: 'nl', name: 'Neerlandés' },
    { code: 'sv', name: 'Sueco' },
    { code: 'no', name: 'Noruego' },
    { code: 'da', name: 'Danés' },
    { code: 'fi', name: 'Finés' },
    { code: 'pl', name: 'Polaco' },
    { code: 'cs', name: 'Checo' },
    { code: 'sk', name: 'Eslovaco' },
    { code: 'sl', name: 'Esloveno' },
    { code: 'hr', name: 'Croata' },
    { code: 'sr', name: 'Serbio' },
    { code: 'hu', name: 'Húngaro' },
    { code: 'ro', name: 'Rumano' },
    { code: 'bg', name: 'Búlgaro' },
    { code: 'el', name: 'Griego' },
    { code: 'tr', name: 'Turco' },
    { code: 'ru', name: 'Ruso' },
    { code: 'uk', name: 'Ucraniano' },
    { code: 'lt', name: 'Lituano' },
    { code: 'lv', name: 'Letón' },
    { code: 'et', name: 'Estonio' },
    { code: 'ar', name: 'Árabe' },
    { code: 'he', name: 'Hebreo' },
    { code: 'fa', name: 'Persa' },
    { code: 'ur', name: 'Urdu' },
    { code: 'hi', name: 'Hindi' },
    { code: 'bn', name: 'Bengalí' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'id', name: 'Indonesio' },
    { code: 'ms', name: 'Malayo' },
    { code: 'tl', name: 'Filipino' },
    { code: 'vi', name: 'Vietnamita' },
    { code: 'th', name: 'Tailandés' },
    { code: 'zh', name: 'Chino simplificado' },
    { code: 'zh-Hant', name: 'Chino tradicional' },
    { code: 'ja', name: 'Japonés' },
    { code: 'ko', name: 'Coreano' },
    { code: 'sw', name: 'Suajili' },
    { code: 'af', name: 'Afrikáans' },
  ];

  // Idiomas que el usuario puede fijar como idioma del audio (códigos de Whisper).
  const SOURCE_LANGUAGES = [
    { code: 'auto', name: 'Detectar automáticamente' },
    ...LANGUAGES.filter((l) => l.code !== 'zh-Hant').map((l) => (l.code === 'zh' ? { code: 'zh', name: 'Chino' } : l)),
  ];

  const FONTS = [
    { code: 'sans', name: 'Sans (YouTube)', css: '"YouTube Noto", Roboto, "Arial Unicode MS", Arial, Helvetica, sans-serif' },
    { code: 'system', name: 'La del sistema', css: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    { code: 'arial', name: 'Arial', css: 'Arial, Helvetica, sans-serif' },
    { code: 'verdana', name: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
    { code: 'trebuchet', name: 'Trebuchet', css: '"Trebuchet MS", "Lucida Grande", sans-serif' },
    { code: 'rounded', name: 'Redondeada', css: 'ui-rounded, "Arial Rounded MT Bold", "Varela Round", sans-serif' },
    { code: 'georgia', name: 'Georgia (con serifa)', css: 'Georgia, "Times New Roman", serif' },
    { code: 'times', name: 'Times New Roman', css: '"Times New Roman", Times, serif' },
    { code: 'mono', name: 'Monoespaciada', css: '"Courier New", Courier, monospace' },
    { code: 'casual', name: 'Informal', css: '"Comic Sans MS", "Chalkboard SE", cursive' },
    { code: 'impact', name: 'Impact', css: 'Impact, "Arial Narrow Bold", sans-serif' },
  ];

  // Modelos de reconocimiento de voz (Whisper, se ejecutan en el propio equipo).
  // "auto" elige entre equilibrado y preciso según la tarjeta gráfica (lib/models.js).
  const MODELS = [
    { code: 'auto', name: 'Automático, según tu equipo' },
    { code: 'tiny', name: 'Rápido (descarga de ~115 MB)', short: 'rápido', repo: 'onnx-community/whisper-tiny' },
    { code: 'base', name: 'Equilibrado (~200 MB)', short: 'equilibrado', repo: 'onnx-community/whisper-base' },
    { code: 'small', name: 'Preciso (~560 MB)', short: 'preciso', repo: 'onnx-community/whisper-small' },
  ];

  const ENGINES = [
    { code: 'auto', name: 'Automático: local y, si no puede, Google' },
    { code: 'chrome', name: 'Solo el traductor local de Chrome' },
    { code: 'google', name: 'Solo Google Translate (en línea)' },
  ];

  // Los colores de los subtítulos de teletexto: blanco, amarillo, cian y verde.
  const TEXT_COLORS = [
    { code: '#ffffff', name: 'Blanco' },
    { code: '#ffe14d', name: 'Amarillo' },
    { code: '#5ce1e6', name: 'Cian' },
    { code: '#7dff7a', name: 'Verde' },
  ];

  const DEFAULTS = {
    targetLang: 'es',
    sourceLang: 'auto',
    textColor: '#ffffff',
    fontFamily: 'sans',
    fontSize: 28, // px
    bgOpacity: 75, // %
    showOriginal: false,
    maxLines: 2,
    model: 'auto',
    engine: 'auto',
    position: { x: 0.5, y: 0.88 }, // centro horizontal y borde inferior, en fracción de la ventana
  };

  const FIELDS = {
    targetLang: { label: 'Traducir a', type: 'select', options: LANGUAGES },
    sourceLang: { label: 'Idioma del audio', type: 'select', options: SOURCE_LANGUAGES },
    textColor: { label: 'Color del texto', type: 'color', options: TEXT_COLORS },
    fontFamily: { label: 'Fuente', type: 'select', options: FONTS },
    fontSize: { label: 'Tamaño', type: 'range', min: 14, max: 64, step: 1, unit: 'px' },
    bgOpacity: { label: 'Fondo', type: 'range', min: 0, max: 100, step: 5, unit: '%' },
    maxLines: {
      label: 'Líneas visibles',
      type: 'select',
      numeric: true,
      options: [1, 2, 3, 4].map((n) => ({ code: n, name: String(n) })),
    },
    showOriginal: { label: 'Mostrar también el texto original', type: 'checkbox' },
    model: { label: 'Reconocimiento de voz', type: 'select', options: MODELS },
    engine: { label: 'Traductor', type: 'select', options: ENGINES },
  };

  const fontCss = (code) => (FONTS.find((f) => f.code === code) ?? FONTS[0]).css;
  const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

  /**
   * Construye el formulario de ajustes. No toca el almacenamiento: avisa de
   * cada cambio con onChange({ clave: valor }) y se refresca con update().
   */
  function createSettingsForm({ fields, onChange }) {
    const form = document.createElement('form');
    form.className = 'lt-form';
    form.addEventListener('submit', (e) => e.preventDefault());
    const updaters = [];
    let uid = 0;

    for (const key of fields) {
      const field = FIELDS[key];
      const id = `lt-${key}-${++uid}`;
      const row = document.createElement('div');
      row.className = `lt-row lt-row-${field.type}`;
      const label = document.createElement('label');
      label.textContent = field.label;
      label.htmlFor = id;

      if (field.type === 'select') {
        const select = document.createElement('select');
        select.id = id;
        for (const option of field.options) select.add(new Option(option.name, String(option.code)));
        select.addEventListener('change', () => {
          onChange({ [key]: field.numeric ? Number(select.value) : select.value });
        });
        updaters.push((s) => (select.value = String(s[key])));
        row.append(label, select);
      } else if (field.type === 'range') {
        const input = document.createElement('input');
        Object.assign(input, { id, type: 'range', min: field.min, max: field.max, step: field.step });
        const output = document.createElement('output');
        output.htmlFor = id;
        const show = (value) => (output.textContent = `${value} ${field.unit}`);
        input.addEventListener('input', () => {
          show(input.value);
          onChange({ [key]: Number(input.value) });
        });
        updaters.push((s) => {
          input.value = s[key];
          show(s[key]);
        });
        row.append(label, input, output);
      } else if (field.type === 'checkbox') {
        const input = document.createElement('input');
        Object.assign(input, { id, type: 'checkbox' });
        input.addEventListener('change', () => onChange({ [key]: input.checked }));
        updaters.push((s) => (input.checked = Boolean(s[key])));
        row.append(input, label);
      } else if (field.type === 'color') {
        // Etiqueta de grupo (no <label>: agrupa varias opciones).
        const caption = document.createElement('span');
        caption.className = 'lt-label';
        caption.id = id;
        caption.textContent = field.label;
        const group = document.createElement('div');
        group.className = 'lt-swatches';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-labelledby', id);
        const buttons = field.options.map((option) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'lt-swatch';
          button.style.setProperty('--swatch', option.code);
          button.title = option.name;
          button.setAttribute('aria-label', option.name);
          button.addEventListener('click', () => onChange({ [key]: option.code }));
          group.append(button);
          return { button, code: option.code };
        });
        const custom = document.createElement('input');
        Object.assign(custom, { type: 'color', className: 'lt-custom-color', title: 'Otro color' });
        custom.setAttribute('aria-label', 'Otro color');
        custom.addEventListener('input', () => onChange({ [key]: custom.value }));
        group.append(custom);
        updaters.push((s) => {
          const value = String(s[key]).toLowerCase();
          let matched = false;
          for (const { button, code } of buttons) {
            const on = code === value;
            matched ||= on;
            button.setAttribute('aria-pressed', String(on));
          }
          custom.value = value;
          custom.classList.toggle('lt-active', !matched);
        });
        row.append(caption, group);
      }
      form.append(row);
    }

    return {
      element: form,
      update(settings) {
        for (const apply of updaters) apply(settings);
      },
    };
  }

  // Estilos del formulario; cada anfitrión define las variables de color.
  const FORM_CSS = `
    .lt-form { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 14px; align-items: center; margin: 0; }
    .lt-row { display: contents; }
    .lt-form label, .lt-label { color: var(--lt-ui-muted); white-space: nowrap; }
    .lt-form select {
      min-width: 0; width: 100%; font: inherit; color: var(--lt-ui-text); background: var(--lt-ui-field);
      border: 1px solid var(--lt-ui-line); border-radius: 6px; padding: 5px 6px;
    }
    .lt-row-range { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
    .lt-row-range input { grid-column: 2; width: 100%; margin: 0; accent-color: var(--lt-ui-accent); }
    .lt-row-range output {
      grid-column: 2; justify-self: end; margin-top: -4px; font-size: 0.85em;
      color: var(--lt-ui-muted); font-variant-numeric: tabular-nums;
    }
    .lt-row-checkbox { display: flex; grid-column: 1 / -1; gap: 8px; align-items: center; }
    .lt-row-checkbox input { margin: 0; accent-color: var(--lt-ui-accent); width: 15px; height: 15px; }
    .lt-row-checkbox label { color: var(--lt-ui-text); white-space: normal; }
    .lt-swatches { display: flex; gap: 8px; align-items: center; }
    .lt-swatch {
      width: 24px; height: 24px; padding: 0; border-radius: 50%; cursor: pointer;
      background: var(--swatch); border: 1px solid var(--lt-ui-line);
      outline: 2px solid transparent; outline-offset: 2px;
    }
    .lt-swatch[aria-pressed="true"] { outline-color: var(--lt-ui-accent); }
    .lt-custom-color {
      width: 30px; height: 26px; padding: 0; border: 1px solid var(--lt-ui-line); border-radius: 6px;
      background: var(--lt-ui-field); cursor: pointer; outline: 2px solid transparent; outline-offset: 2px;
    }
    .lt-custom-color.lt-active { outline-color: var(--lt-ui-accent); }
    .lt-form :focus-visible { outline: 2px solid var(--lt-ui-focus); outline-offset: 2px; }
  `;

  globalThis.LT = {
    LANGUAGES,
    SOURCE_LANGUAGES,
    FONTS,
    MODELS,
    ENGINES,
    TEXT_COLORS,
    DEFAULTS,
    FIELDS,
    FORM_CSS,
    fontCss,
    languageName,
    createSettingsForm,
  };
})();
