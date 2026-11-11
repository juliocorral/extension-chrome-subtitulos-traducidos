// Service worker: coordina el popup, el documento offscreen (que captura y
// traduce el audio) y la barra de subtítulos inyectada en la pestaña.
importScripts('shared/config.js');

const { DEFAULTS } = self.LT;
const IDLE = { tabId: null, status: { phase: 'idle' } };
// Ajustes que afectan al reconocimiento o la traducción (el resto son de aspecto).
const PIPELINE_KEYS = ['targetLang', 'sourceLang', 'model', 'engine'];

let cached = null;

async function getState() {
  cached ??= (await chrome.storage.session.get({ lt: IDLE })).lt;
  return cached;
}

// El popup, si está abierto, se entera de los cambios por storage.session.
async function setState(next) {
  cached = next;
  await chrome.storage.session.set({ lt: next });
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capturar el audio de la pestaña para transcribirlo y traducirlo.',
    })
    .finally(() => (creating = null));
  await creating;
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/config.js', 'shared/rollup.js', 'content/overlay.js'] });
    return true;
  } catch (err) {
    console.warn('[subtítulos] no se pudo mostrar la barra en la pestaña:', err);
    return false;
  }
}

function friendly(err) {
  const message = err?.message ?? String(err);
  if (/has not been invoked|cannot be captured|Chrome pages/i.test(message)) {
    return 'Chrome no permite capturar el audio de esta página. Prueba en una pestaña con un vídeo o un audio.';
  }
  if (/active stream/i.test(message)) {
    return 'El audio de esta pestaña ya se está capturando. Detén la otra captura y vuelve a intentarlo.';
  }
  return message;
}

async function start(tabId, streamId) {
  if ((await getState()).tabId !== null) await stop();
  try {
    streamId ??= await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    await setState({ tabId, status: { phase: 'starting' } });
    const settings = await chrome.storage.local.get(DEFAULTS);
    const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, settings });
    if (!reply?.ok) throw new Error(reply?.error ?? 'No se pudo capturar el audio de la pestaña.');
  } catch (err) {
    await stop();
    throw new Error(friendly(err));
  }

  const overlay = await injectOverlay(tabId);
  const state = await getState();
  if (state.tabId === tabId) await setState({ ...state, overlay });
  await chrome.action.setBadgeBackgroundColor({ color: '#14171a' });
  await chrome.action.setBadgeTextColor({ color: '#ffe14d' });
  await chrome.action.setBadgeText({ text: 'ON' });
}

async function stop() {
  // Detiene la captura, cierra el documento offscreen y retira la barra.
  const { tabId } = await getState();
  await setState(IDLE);
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  if (tabId !== null) chrome.tabs.sendMessage(tabId, { type: 'lt:remove' }).catch(() => {});
  await chrome.action.setBadgeText({ text: '' });
}

/** Estado para el popup; si el documento de captura murió, se da por parado. */
async function currentState() {
  const state = await getState();
  if (state.tabId !== null && !creating && !(await hasOffscreen())) {
    await setState(IDLE);
    await chrome.action.setBadgeText({ text: '' });
    return IDLE;
  }
  return state;
}

function toTab(message) {
  getState().then((state) => {
    if (state.tabId !== null) chrome.tabs.sendMessage(state.tabId, message).catch(() => {});
  });
}

const fromOffscreen = (sender) => sender.url === chrome.runtime.getURL('offscreen.html');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return;
  const reply = (promise) => {
    promise.then(
      (value) => sendResponse({ ok: true, ...value }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
    );
    return true;
  };

  switch (message.type) {
    case 'lt:start':
      return reply(start(message.tabId, message.streamId).then(async () => ({ state: await getState() })));
    case 'lt:stop':
      return reply(stop().then(() => ({ state: IDLE })));
    case 'lt:get-state':
      return reply(currentState().then((state) => ({ state })));
    case 'lt:overlay-ready':
      return reply(getState().then((state) => ({ active: sender.tab?.id === state.tabId, status: state.status })));
    case 'lt:open-popup':
      // Puede fallar si la ventana no tiene el foco; entonces no pasa nada.
      chrome.action.openPopup().catch(() => {});
      return;
    case 'lt:caption':
      if (fromOffscreen(sender)) toTab(message);
      return;
    case 'lt:status':
      if (fromOffscreen(sender)) {
        getState().then((state) => {
          if (state.tabId === null) return;
          setState({ ...state, status: message.status });
          toTab(message);
        });
      }
      return;
    case 'lt:ended':
      if (fromOffscreen(sender)) stop();
      return;
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !PIPELINE_KEYS.some((key) => key in changes)) return;
  if ((await getState()).tabId === null) return;
  const settings = await chrome.storage.local.get(DEFAULTS);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'settings', settings }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getState()).tabId === tabId) stop();
});

// La captura sobrevive a una recarga o navegación de la pestaña; la barra no.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  if ((await getState()).tabId !== tabId) return;
  // Otra página u otro vídeo (YouTube cambia de vídeo sin recargar: solo
  // cambia la dirección): el idioma del audio se detecta de nuevo.
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'new-page' }).catch(() => {});
  if (changeInfo.status === 'complete') injectOverlay(tabId);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translation' || !tab?.id) return;
  try {
    if ((await getState()).tabId === tab.id) await stop();
    else await start(tab.id);
    await chrome.action.setTitle({ title: 'Subtítulos traducidos en vivo' });
  } catch (err) {
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: err.message });
  }
});
