// Popup: inicia o detiene los subtítulos en la pestaña actual y reúne todos
// los ajustes. Los cambios se guardan al instante y la barra los aplica sola.
import { sameLanguage } from '../lib/langs.js';

const { DEFAULTS, MODELS, createSettingsForm, fontCss, languageName, FORM_CSS } = globalThis.LT;
const $ = (id) => document.getElementById(id);

// Frase de muestra en el idioma al que se traduce.
const SAMPLES = {
  es: 'Así se verán los subtítulos',
  en: 'This is how your subtitles will look',
  fr: 'Voici à quoi ressembleront les sous-titres',
  de: 'So werden die Untertitel aussehen',
  it: 'Ecco come appariranno i sottotitoli',
  pt: 'É assim que as legendas vão aparecer',
  ca: 'Així es veuran els subtítols',
  gl: 'Así se verán os subtítulos',
  eu: 'Horrela ikusiko dira azpitituluak',
  ru: 'Так будут выглядеть субтитры',
  ar: 'هكذا ستظهر الترجمة',
  zh: '字幕将这样显示',
  'zh-Hant': '字幕將這樣顯示',
  ja: '字幕はこのように表示されます',
  ko: '자막이 이렇게 표시됩니다',
};

let tab = null;
let settings = { ...DEFAULTS };
let state = { tabId: null, status: { phase: 'idle' } };
let startError = null;
let busy = false;
let download = null; // { pair, progress } mientras se descarga un paquete de idioma
let forms = [];

const send = (message) => chrome.runtime.sendMessage(message);
const save = (patch) => chrome.storage.local.set(patch);
const lower = (code) => languageName(code).toLowerCase();

function canCapture(target) {
  return Boolean(target?.id) && /^(https?|file):/.test(target.url ?? '');
}

// ---------- vista ----------

function renderPreview() {
  const sample = $('sample');
  sample.textContent = SAMPLES[settings.targetLang] ?? SAMPLES.es;
  sample.style.setProperty('--color', settings.textColor);
  sample.style.setProperty('--font', fontCss(settings.fontFamily));
  sample.style.setProperty('--size', `${settings.fontSize}px`);
  sample.style.setProperty('--alpha', settings.bgOpacity / 100);
}

function translatorSentence(translator) {
  if (!translator) return '';
  const pair = `de ${lower(translator.source ?? 'en')} a ${lower(translator.target)}`;
  switch (translator.engine) {
    case 'chrome':
      return ` Traduce ${pair} el modelo local de Chrome: nada sale de tu equipo.`;
    case 'google':
      return translator.fallback
        ? ` Traduce ${pair} Google Translate porque el traductor local aún no está disponible.`
        : ` Traduce ${pair} Google Translate (en línea).`;
    case 'none':
      return ` El audio ya está en ${lower(translator.target)}: se muestra tal cual.`;
    case 'error':
      return ` No se pudo traducir (${translator.error}); se muestra el texto original.`;
    default:
      return '';
  }
}

function statusText() {
  if (startError) return { kind: 'error', text: startError };
  if (!canCapture(tab) && state.tabId === null) {
    return { kind: 'info', text: 'Chrome no permite subtitular esta página. Abre una pestaña con un vídeo o un audio.' };
  }
  if (state.tabId === null) return { kind: 'info', text: 'Pon un vídeo o un audio en esta pestaña y pulsa el botón.' };
  if (state.tabId !== tab?.id) return { kind: 'info', text: 'Ahora mismo se está subtitulando otra pestaña.' };

  const status = state.status ?? {};
  switch (status.phase) {
    case 'loading-model':
      return status.progress != null && status.progress < 100
        ? { kind: 'info', text: `Descargando el modelo de voz: ${status.progress} %. Solo hace falta la primera vez.` }
        : { kind: 'info', text: 'Cargando el modelo de voz…' };
    case 'listening': {
      const noBar = state.overlay === false ? ' En esta página no se puede mostrar la barra.' : '';
      return { kind: 'info', text: `Escuchando esta pestaña.${translatorSentence(status.translator)}${noBar}` };
    }
    case 'error':
      return { kind: 'error', text: status.message ?? 'Algo ha fallado.' };
    default:
      return { kind: 'info', text: 'Preparando los subtítulos…' };
  }
}

function render() {
  const here = state.tabId !== null && state.tabId === tab?.id;
  const elsewhere = state.tabId !== null && !here;

  const toggle = $('toggle');
  toggle.textContent = here ? 'Detener los subtítulos' : elsewhere ? 'Pasar los subtítulos a esta pestaña' : 'Subtitular esta pestaña';
  toggle.dataset.running = String(here);
  toggle.disabled = busy || (!here && !canCapture(tab));
  $('stop-other').hidden = !elsewhere;

  const { kind, text } = statusText();
  $('status').textContent = text;
  $('status').dataset.kind = kind;

  const device = state.status?.device;
  const model = MODELS.find((m) => m.code === state.status?.model)?.short;
  const using = model ? `Reconocimiento de voz con el modelo ${model}` : 'Reconocimiento de voz';
  $('engine-hint').textContent = !here || !device
    ? ''
    : device === 'webgpu'
      ? `${using}, en la tarjeta gráfica (WebGPU).`
      : `${using}, en el procesador. Si los subtítulos llegan con retraso, elige el modelo rápido.`;
  $('engine-hint').hidden = !$('engine-hint').textContent;

  renderPreview();
  for (const form of forms) form.update(settings);
}

// ---------- traductor local de Chrome ----------

const pairKey = (pair) => `${pair.sourceLanguage}>${pair.targetLanguage}`;

/**
 * Par de idiomas con el que el traductor local no está pudiendo trabajar en
 * esta pestaña, o null si no hay nada que avisar. `failing` indica que además
 * no hay traducción alguna (el traductor en línea tampoco responde); si no,
 * Google lo está supliendo. En reposo nunca hay aviso: Chrome no dice de fiar
 * qué paquetes tiene hasta que se usan.
 */
function strugglingPair() {
  const translator = state.tabId !== null && state.tabId === tab?.id ? state.status?.translator : null;
  if (!translator?.source) return null;
  const failing = translator.engine === 'error';
  if (!failing && !translator.fallback) return null;
  return { failing, pair: { sourceLanguage: translator.source, targetLanguage: translator.target } };
}

function showNotice(text, action = null) {
  $('notice').hidden = !text;
  $('notice-text').textContent = text ?? '';
  const button = $('notice-action');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.run;
  }
}

let noticeTicket = 0;

async function refreshNotice() {
  // Las comprobaciones son asíncronas: solo la más reciente puede pintar el aviso.
  const ticket = ++noticeTicket;
  const struggling = strugglingPair();
  if (!struggling) return showNotice(null);
  const { failing, pair } = struggling;
  const names = `de ${lower(pair.sourceLanguage)} a ${lower(pair.targetLanguage)}`;
  const localOnly = settings.engine === 'chrome';
  const useAuto = ' Elige «Automático» en Más opciones para traducir con Google.';
  const untranslated = ' Mientras tanto los subtítulos salen sin traducir.';
  const offline = `El traductor en línea no responde ahora mismo.${untranslated} Vuelve a intentarlo en unos minutos.`;

  if (!('Translator' in self)) {
    return showNotice(localOnly ? `Este Chrome no incluye el traductor local.${useAuto}` : failing ? offline : null);
  }
  if (download?.pair === pairKey(pair) && download.visible) {
    return showNotice(`Descargando el traductor local ${names}: ${Math.round(download.progress * 100)} %.`);
  }

  let availability = 'unavailable';
  try {
    availability = await self.Translator.availability(pair);
  } catch {
    // Par de idiomas que Chrome no reconoce.
  }
  if (ticket !== noticeTicket) return;

  if (availability === 'available') {
    // Ya está en el equipo: la traducción lo recogerá sola en unos segundos.
    return showNotice(failing ? `El traductor local ${names} ya está listo; los subtítulos volverán a traducirse enseguida.` : null);
  }
  if (availability === 'unavailable') {
    if (localOnly) return showNotice(`Chrome no tiene traductor local ${names}.${useAuto}`);
    return showNotice(failing ? `Chrome no tiene traductor local ${names}. ${offline}` : null);
  }
  const meanwhile = failing ? untranslated : settings.engine === 'auto' ? ' Mientras tanto traduce Google.' : '';
  showNotice(`El traductor local ${names} todavía no está descargado.${meanwhile}`, {
    label: 'Descargar el traductor local',
    run: () => downloadLocalTranslator(pair),
  });
}

/** Debe llamarse dentro de un clic: Chrome solo inicia la descarga con un gesto del usuario. */
async function downloadLocalTranslator(pair) {
  const key = pairKey(pair);
  if (download?.pair === key) return;
  download = { pair: key, progress: 0, visible: false };
  // Si el paquete ya estaba en el equipo esto termina al instante: el aviso de
  // descarga solo se enseña cuando de verdad hay algo bajando.
  const reveal = () => {
    if (download?.pair !== key || download.visible) return;
    download.visible = true;
    refreshNotice();
  };
  setTimeout(reveal, 400);
  try {
    const translator = await self.Translator.create({
      ...pair,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          if (download?.pair !== key) return;
          download.progress = event.loaded;
          if (event.loaded > 0 && event.loaded < 1) reveal();
          if (download.visible) refreshNotice();
        });
      },
    });
    translator.destroy?.();
  } catch (err) {
    console.warn('[subtítulos] no se pudo descargar el traductor local:', err);
  }
  if (download?.pair === key) download = null;
  refreshNotice();
}

/** Aprovecha el clic de "Subtitular" para dejar listo el traductor local. */
async function prepareLocalTranslator() {
  if (settings.engine === 'google' || !('Translator' in self)) return;
  const source = settings.sourceLang !== 'auto' ? settings.sourceLang : 'en';
  if (sameLanguage(source, settings.targetLang)) return;
  const pair = { sourceLanguage: source, targetLanguage: settings.targetLang };
  try {
    if ((await self.Translator.availability(pair)) === 'downloadable') downloadLocalTranslator(pair);
  } catch {
    // Par no admitido: se usará Google si el modo lo permite.
  }
}

// ---------- acciones ----------

async function onToggle() {
  startError = null;
  busy = true;
  render();
  try {
    if (state.tabId === tab.id) {
      const reply = await send({ type: 'lt:stop' });
      state = reply.state;
    } else {
      prepareLocalTranslator();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const reply = await send({ type: 'lt:start', tabId: tab.id, streamId });
      if (!reply.ok) throw new Error(reply.error);
      state = reply.state;
    }
  } catch (err) {
    const message = err?.message ?? String(err);
    startError = /has not been invoked|cannot be captured|Chrome pages/i.test(message)
      ? 'Chrome no permite capturar el audio de esta página.'
      : message;
  }
  busy = false;
  render();
  refreshNotice();
}

async function init() {
  const style = document.createElement('style');
  style.textContent = FORM_CSS;
  document.head.append(style);

  const main = createSettingsForm({
    fields: ['targetLang', 'sourceLang', 'textColor', 'fontFamily', 'fontSize', 'bgOpacity', 'showOriginal'],
    onChange: save,
  });
  const advanced = createSettingsForm({ fields: ['maxLines', 'model', 'engine'], onChange: save });
  $('settings').append(main.element);
  $('advanced').append(advanced.element);
  forms = [main, advanced];

  [[tab], settings] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get(DEFAULTS),
  ]);
  const reply = await send({ type: 'lt:get-state' });
  if (reply?.state) state = reply.state;

  $('toggle').addEventListener('click', onToggle);
  $('stop-other').addEventListener('click', async () => {
    const stopped = await send({ type: 'lt:stop' });
    state = stopped.state;
    render();
  });
  $('reset-position').addEventListener('click', () => save({ position: DEFAULTS.position }));

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((command) => command.name === 'toggle-translation')?.shortcut;
  $('shortcut-hint').textContent = shortcut
    ? `Atajo para iniciar o detener: ${shortcut}.`
    : 'Puedes asignar un atajo de teclado en chrome://extensions/shortcuts.';

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.lt) {
      // El service worker guarda aquí el estado de la traducción en curso.
      state = changes.lt.newValue ?? { tabId: null, status: { phase: 'idle' } };
      render();
      refreshNotice();
    } else if (area === 'local') {
      for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue ?? DEFAULTS[key];
      render();
      if ('engine' in changes) refreshNotice();
    }
  });

  render();
  refreshNotice();
}

init();
