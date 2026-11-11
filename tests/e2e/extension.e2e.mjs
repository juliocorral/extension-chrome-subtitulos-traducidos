// Prueba de extremo a extremo: carga la extensión en Chrome, reproduce una
// locución en una pestaña y comprueba que la barra muestra su traducción.
//
//   npm run test:e2e
//
// Necesita Google Chrome, openssl y conexión a internet: cada ejecución usa
// un perfil de Chrome nuevo y descarga el modelo de voz (~200 MB). La locución
// de prueba suena por los altavoces, muy baja, mientras dura.
//
// El traductor en línea no se toca: las peticiones a translate.googleapis.com
// se desvían a un servidor local que hace de Google (ver fakeGoogle). Así la
// prueba no depende de un servicio que limita las peticiones, y se puede
// ensayar qué pasa cuando responde que está saturado.
//
// LT_E2E_PROFILE=/ruta reutiliza un perfil (y su modelo ya descargado). Ojo:
// Chrome guarda en el perfil el service worker de la extensión y no lo renueva
// aunque cambie background.js; la prueba lo detecta y pide borrar el perfil.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(here, '..', '..', 'extension');
const FIXTURES = path.join(here, '..', 'fixtures');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REUSED_PROFILE = process.env.LT_E2E_PROFILE ?? null;
const HEADLESS = process.env.LT_E2E_HEADFUL ? false : true;

const MODEL_TIMEOUT = 15 * 60_000; // la primera descarga del modelo puede tardar
const CAPTION_TIMEOUT = 90_000;

let browser;
let profile;
let server;
let google; // { server, port, requests }
let scratch; // carpeta temporal para el certificado
let localSpanish = false; // ¿tiene este Chrome el traductor local inglés→español?
let origin;
let extension;
let page;

const TYPES = { '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav' };

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const name = path.basename(url.pathname) || 'page.html';
      const body = await readFile(path.join(FIXTURES, name));
      const headers = { 'Content-Type': TYPES[path.extname(name)] ?? 'application/octet-stream' };
      // ?tt=1 sirve la página con la misma exigencia de Trusted Types que YouTube.
      if (url.searchParams.has('tt')) headers['Content-Security-Policy'] = "require-trusted-types-for 'script'";
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  scratch = await mkdtemp(path.join(os.tmpdir(), 'subtitulos-e2e-cert-'));
  google = await fakeGoogle(scratch);
  profile = REUSED_PROFILE ?? (await mkdtemp(path.join(os.tmpdir(), 'subtitulos-e2e-')));
  browser = await launchChrome();
  const id = await browser.installExtension(EXTENSION);
  extension = (await browser.extensions()).get(id);
  assert.ok(extension, 'la extensión no se ha cargado');
  await assertFreshWorker();
  // Ajustes de fábrica, salvo el modelo: se fija el equilibrado para que la
  // prueba descargue lo mismo en cualquier equipo.
  await inExtensionPage(() => chrome.storage.local.clear().then(() => chrome.storage.local.set({ model: 'base' })));
  // Se deja cargado el traductor local de Chrome (si lo hay) para que la
  // primera frase ya se traduzca con él y no con el servidor de pega.
  localSpanish = await inExtensionPage(async () => {
    try {
      const translator = await self.Translator.create({ sourceLanguage: 'en', targetLanguage: 'es' });
      return /hola/i.test(await translator.translate('Hello'));
    } catch {
      return false;
    }
  });
});

after(async () => {
  await browser?.close();
  server?.close();
  google?.server.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (profile && !REUSED_PROFILE) await rm(profile, { recursive: true, force: true, maxRetries: 5 });
});

// ---------- utilidades ----------

/**
 * Un servidor local que hace de translate.googleapis.com. No traduce de
 * verdad: devuelve el mismo texto cambiando las expresiones que las pruebas
 * buscan. Al alemán responde siempre 429, como Google cuando se satura.
 */
async function fakeGoogle(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', key, '-out', cert, '-subj', '/CN=translate.googleapis.com'],
    { stdio: 'ignore' },
  );
  const phrases = {
    fr: [[/black holes/gi, 'trous noirs']],
    es: [
      [/black holes/gi, 'agujeros negros'],
      [/cuisine française/gi, 'cocina francesa'],
    ],
  };
  const requests = [];
  const fake = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'https://translate.googleapis.com');
      const text = new URLSearchParams(body).get('q') ?? '';
      const target = url.searchParams.get('tl');
      requests.push({ at: Date.now(), target, text });
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
      if (target === 'de') {
        res.writeHead(429, headers).end('{}');
        return;
      }
      let translated = text;
      for (const [from, to] of phrases[target] ?? []) translated = translated.replace(from, to);
      res.writeHead(200, headers).end(JSON.stringify([[[translated, text, null, null, 1]], null, url.searchParams.get('sl')]));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  return { server: fake, port: fake.address().port, requests };
}

function launchChrome() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    defaultViewport: null,
    // Puppeteer silencia Chrome por defecto y entonces la captura de la
    // pestaña solo recibe silencio: la prueba necesita audio de verdad.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,800',
      // El traductor en línea, al servidor de pega (con su certificado casero).
      `--host-resolver-rules=MAP translate.googleapis.com 127.0.0.1:${google.port}`,
      '--ignore-certificate-errors',
    ],
  });
}

/** Falla si el service worker en marcha no es el background.js del disco. */
async function assertFreshWorker() {
  const onDisk = await readFile(path.join(EXTENSION, 'background.js'), 'utf8');
  // La consulta de estado despierta al worker; de paso se lee la configuración actual.
  const config = await inExtensionPage(async () => {
    await chrome.runtime.sendMessage({ type: 'lt:get-state' });
    return JSON.stringify([LT.DEFAULTS, LT.MODELS]);
  });
  const [worker] = await extension.workers();
  assert.ok(worker, 'el service worker no está en marcha');
  const running = await worker.evaluate(() => ({
    functions: [setState, start, stop, currentState, injectOverlay].map(String),
    config: JSON.stringify([self.LT.DEFAULTS, self.LT.MODELS]),
  }));
  assert.ok(
    running.functions.every((source) => onDisk.includes(source)),
    'el perfil reutilizado conserva un service worker antiguo: borra la carpeta de LT_E2E_PROFILE',
  );
  assert.equal(running.config, config, 'el perfil reutilizado conserva una configuración antigua: bórralo');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Texto del subtítulo tal y como se lee en pantalla: sus líneas, de arriba
// abajo, unidas por un espacio. Disponible como caption(root) dentro de las
// funciones que se pasan a inOverlay y waitInOverlay.
const CAPTION = `(root) => [...root.querySelectorAll('.lt-text .lt-line:not(.lt-leaving)')].map((line) => line.textContent).join(' ')`;

/** Evalúa `fn(raízDeLaBarra, ...args)` dentro de la página. */
function inOverlay(fn, ...args) {
  return page.evaluate(
    (source, fnArgs, helper) => {
      const root = document.querySelector('lt-subtitles')?.shadowRoot;
      if (!root) return null;
      const caption = new Function(`return (${helper})`)();
      return new Function('caption', `return (${source})`)(caption)(root, ...fnArgs);
    },
    fn.toString(),
    args,
    CAPTION,
  );
}

function waitInOverlay(fn, timeout, ...args) {
  return page.waitForFunction(
    (source, fnArgs, helper) => {
      const root = document.querySelector('lt-subtitles')?.shadowRoot;
      if (!root) return false;
      const caption = new Function(`return (${helper})`)();
      return new Function('caption', `return (${source})`)(caption)(root, ...fnArgs);
    },
    { timeout, polling: 250 },
    fn.toString(),
    args,
    CAPTION,
  );
}

/**
 * Espera a que el subtítulo visible cumpla `pattern`. Si no llega, el error
 * cuenta qué había en pantalla y qué se le pidió al traductor en línea.
 */
async function waitForCaption(pattern, timeout = CAPTION_TIMEOUT) {
  try {
    await waitInOverlay((root, source, flags) => new RegExp(source, flags).test(caption(root)), timeout, pattern.source, pattern.flags);
  } catch (err) {
    const shown = await inOverlay((root) => caption(root) || `(sin subtítulo; estado: ${root.querySelector('.lt-status-text')?.textContent})`);
    const asked = google.requests.slice(-4).map((r) => `→${r.target} «${r.text.slice(-60)}»`).join('\n    ');
    const status = await inExtensionPage(() => chrome.storage.session.get('lt')).then((s) => JSON.stringify(s.lt?.status));
    throw new Error(
      `no ha aparecido ${pattern} en ${timeout} ms.\n  En pantalla: ${shown}\n  Estado: ${status}\n  Últimas peticiones al traductor en línea:\n    ${asked || '(ninguna)'}`,
      { cause: err },
    );
  }
}

const barRect = () =>
  inOverlay((root) => {
    const r = root.querySelector('.lt-bar').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, bottom: r.bottom };
  });

// La locución suena por los altavoces mientras dura la prueba; se pone muy
// baja (de paso se comprueba que el reconocimiento aguanta un volumen flojo).
/**
 * Punto por donde se agarra la barra: el centro de su texto visible (o del
 * indicador de estado). El resto de la barra es transparente al ratón.
 */
const grip = () =>
  inOverlay((root) => {
    const target = [...root.querySelectorAll('.lt-bar .lt-line, .lt-bar .lt-status')].find(
      (el) => el.getClientRects().length > 0,
    );
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

const replay = (name) =>
  page.evaluate(async (file) => {
    const audio = document.getElementById('speech');
    if (file && !audio.src.endsWith(file)) audio.src = file;
    audio.volume = 0.05;
    audio.currentTime = 0;
    await audio.play();
  }, name);

async function popupPage() {
  for (let i = 0; i < 50; i++) {
    const pages = await extension.pages();
    const popup = pages.find((p) => p.url().includes('popup/popup.html'));
    if (popup) return popup;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el popup no se ha abierto');
}

/** Ejecuta `fn` en una página de la propia extensión (con acceso a chrome.*). */
async function inExtensionPage(fn) {
  const tab = await browser.newPage();
  try {
    await tab.goto(`chrome-extension://${extension.id}/popup/popup.html`);
    return await tab.evaluate(fn);
  } finally {
    await tab.close();
  }
}

// ---------- pruebas (en orden: comparten la misma pestaña) ----------

// ---------- avisos del popup sobre el traductor local ----------

/**
 * Abre el popup en una pestaña con una API Translator simulada.
 * `delays` retrasa la respuesta de availability() para ciertos idiomas de destino.
 */
async function popupWithFakeTranslator({ delays = {} } = {}) {
  const tab = await browser.newPage();
  await tab.goto(`chrome-extension://${extension.id}/popup/popup.html`);
  await tab.waitForSelector('#toggle');
  await tab.evaluate((slow) => {
    const fake = { availability: 'downloadable', requested: null, finish: null };
    self.__fake = fake;
    self.Translator = {
      availability: async ({ targetLanguage }) => {
        if (slow[targetLanguage]) await new Promise((r) => setTimeout(r, slow[targetLanguage]));
        return fake.availability;
      },
      create: async ({ sourceLanguage, targetLanguage, monitor }) => {
        fake.requested = `${sourceLanguage}>${targetLanguage}`;
        const events = new EventTarget();
        monitor?.(events);
        events.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.5 }));
        await new Promise((resolve) => (fake.finish = resolve));
        fake.availability = 'available';
        return { destroy() {} };
      },
    };
  }, delays);
  return tab;
}

/** Simula que esta pestaña se está subtitulando y Google suple al traductor local. */
const pretendFallback = (tab, target) =>
  tab.evaluate(async (targetLang) => {
    const [me] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.storage.session.set({
      lt: {
        tabId: me.id,
        status: {
          phase: 'listening',
          translator: { engine: 'google', fallback: 'not-ready', error: null, source: 'en', target: targetLang },
        },
      },
    });
  }, target);

const closePopupTab = async (tab) => {
  await tab.evaluate(() => chrome.storage.session.remove('lt')).catch(() => {});
  await tab.close();
};

const noticeText = (tab) => tab.$eval('#notice', (el) => (el.hidden ? '' : el.querySelector('#notice-text').textContent));

test('en reposo el popup no da avisos sobre el traductor local', { timeout: 30_000 }, async () => {
  const tab = await popupWithFakeTranslator();
  try {
    await tab.evaluate(() => chrome.storage.local.set({ targetLang: 'de' }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await noticeText(tab), '');
  } finally {
    await tab.evaluate(() => chrome.storage.local.set({ targetLang: 'es' })).catch(() => {});
    await closePopupTab(tab);
  }
});

test('si Google está supliendo al traductor local, el popup ofrece descargarlo', { timeout: 30_000 }, async () => {
  const tab = await popupWithFakeTranslator();
  try {
    await pretendFallback(tab, 'de');
    await tab.waitForFunction(() => !document.getElementById('notice-action').hidden, { timeout: 5_000 });
    const notice = await noticeText(tab);
    assert.match(notice, /de inglés a alemán/);
    assert.match(notice, /no está descargado/);

    await tab.click('#notice-action');
    await tab.waitForFunction(() => /50 %/.test(document.getElementById('notice-text').textContent), { timeout: 5_000 });
    assert.equal(await tab.evaluate(() => self.__fake.requested), 'en>de');

    await tab.evaluate(() => self.__fake.finish());
    await tab.waitForFunction(() => document.getElementById('notice').hidden, { timeout: 5_000 });
  } finally {
    await closePopupTab(tab);
  }
});

test('si no hay traducción y el traductor local está sin descargar, el popup lo explica y ofrece descargarlo', { timeout: 30_000 }, async () => {
  const tab = await popupWithFakeTranslator();
  try {
    await tab.evaluate(async () => {
      const [me] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.storage.session.set({
        lt: {
          tabId: me.id,
          status: {
            phase: 'listening',
            translator: { engine: 'error', fallback: null, error: 'El traductor de Google respondió 429', source: 'fr', target: 'es' },
          },
        },
      });
    });
    await tab.waitForFunction(() => !document.getElementById('notice-action').hidden, { timeout: 5_000 });
    const notice = await noticeText(tab);
    assert.match(notice, /de francés a español/);
    assert.match(notice, /sin traducir/);
    await tab.click('#notice-action');
    await tab.waitForFunction(() => self.__fake.requested === 'fr>es', { timeout: 5_000 });
  } finally {
    await tab.evaluate(() => self.__fake.finish?.()).catch(() => {});
    await closePopupTab(tab);
  }
});

test('el aviso del popup corresponde siempre al último par de idiomas', { timeout: 30_000 }, async () => {
  // La comprobación del alemán tarda; la del francés, pedida después, llega antes.
  const tab = await popupWithFakeTranslator({ delays: { de: 400 } });
  try {
    await pretendFallback(tab, 'de');
    await pretendFallback(tab, 'fr');
    await new Promise((r) => setTimeout(r, 900));
    assert.match(await noticeText(tab), /de inglés a francés/);
  } finally {
    await closePopupTab(tab);
  }
});

test('al pulsar el botón del popup aparece la barra y empieza a escuchar', { timeout: MODEL_TIMEOUT + 60_000 }, async () => {
  page = await browser.newPage();
  await page.goto(`${origin}/page.html?audio=en`);
  await page.bringToFront();

  await extension.triggerAction(page);
  const popup = await popupPage();
  await popup.waitForSelector('#toggle:not([disabled])');
  await popup.click('#toggle');

  await page.waitForFunction(() => document.querySelector('lt-subtitles')?.shadowRoot?.querySelector('.lt-bar'), {
    timeout: 20_000,
  });
  await waitInOverlay((root) => root.querySelector('.lt-bar').dataset.phase === 'listening', MODEL_TIMEOUT);
});

test('el audio en inglés aparece traducido al español', { timeout: CAPTION_TIMEOUT + 30_000 }, async () => {
  await replay();
  await waitForCaption(/agujeros negros/i);
  const text = await inOverlay((root) => caption(root));
  assert.doesNotMatch(text, /black holes/i, 'se está mostrando el original en vez de la traducción');
});

test('con el traductor local de Chrome la traducción es de verdad, hecha en el equipo', { timeout: CAPTION_TIMEOUT + 30_000 }, async (t) => {
  if (!localSpanish) return t.skip('este Chrome no tiene descargado el traductor local de inglés a español');
  const before = google.requests.length;
  await page.evaluate(() => document.getElementById('speech').pause());
  await waitInOverlay((root) => root.querySelector('.lt-caption').hidden, 20_000);
  await replay();
  // "bienvenidos" solo puede salir de un traductor de verdad: el servidor de pega deja "welcome".
  await waitForCaption(/bienvenidos/i);
  assert.equal(google.requests.length, before, 'el texto no debe salir del equipo si el traductor local funciona');
});

test('mientras hay subtítulo, la barra no muestra además el indicador de estado', { timeout: CAPTION_TIMEOUT }, async () => {
  await replay();
  await waitInOverlay((root) => caption(root).length > 0, CAPTION_TIMEOUT);
  const visible = await inOverlay((root) =>
    [...root.querySelectorAll('.lt-bar .lt-status')].filter((el) => el.getClientRects().length > 0).map((el) => el.textContent),
  );
  assert.deepEqual(visible, [], 'junto al subtítulo se ve también el texto de estado');
});

test('los subtítulos se escriben palabra a palabra y las líneas suben sin recolocar el texto', { timeout: CAPTION_TIMEOUT }, async () => {
  // Se parte de la barra vacía y se anota cada cambio de sus líneas mientras suena la locución.
  await page.evaluate(() => document.getElementById('speech').pause());
  await waitInOverlay((root) => root.querySelector('.lt-caption').hidden, 20_000);
  await page.evaluate(() => {
    const text = document.querySelector('lt-subtitles').shadowRoot.querySelector('.lt-text');
    const samples = (window.__samples = []);
    window.__observer = new MutationObserver(() => {
      samples.push({
        at: performance.now(),
        lines: [...text.querySelectorAll('.lt-line:not(.lt-leaving)')].map((line) => ({
          id: line.dataset.line,
          words: line.querySelectorAll('.lt-word').length,
          text: line.textContent,
        })),
      });
    });
    window.__observer.observe(text, { childList: true, subtree: true, characterData: true, attributeFilter: ['class'] });
  });
  await replay();
  // Hasta el final de la locución («…in the universe»), venga la traducción de donde venga.
  await waitForCaption(/univers/i, 60_000);
  await sleep(1_500);
  const samples = await page.evaluate(() => {
    window.__observer.disconnect();
    return window.__samples;
  });

  const seen = new Map(); // línea → último estado visto
  const additions = []; // instante de cada palabra nueva
  let mostLines = 0;
  for (const sample of samples) {
    mostLines = Math.max(mostLines, sample.lines.length);
    for (const line of sample.lines) {
      const before = seen.get(line.id) ?? { words: 0, text: '' };
      const added = line.words - before.words;
      assert.ok(added >= 0, `la línea «${before.text}» ha perdido palabras`);
      assert.ok(added <= 1, `han aparecido ${added} palabras de golpe: «${line.text}»`);
      assert.ok(line.text.startsWith(before.text), `se ha reescrito «${before.text}» como «${line.text}»`);
      if (added) additions.push(sample.at);
      seen.set(line.id, line);
    }
  }

  assert.ok(additions.length >= 12, `solo se han escrito ${additions.length} palabras`);
  const gaps = additions.slice(1).map((at, i) => at - additions[i]);
  assert.ok(Math.min(...gaps) >= 30, `dos palabras han salido con solo ${Math.round(Math.min(...gaps))} ms de diferencia`);
  assert.ok(mostLines <= 2, `ha llegado a haber ${mostLines} líneas a la vez`);
  assert.ok(seen.size >= 3, 'el texto no ha llegado a subir de línea');

  // Todo lo escrito, de la primera línea a la última: nada debe salir dos veces.
  const written = [...seen.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, line]) => line.text)
    .join(' ');
  assert.equal(written.match(/agujeros negros/gi)?.length, 1, `texto repetido o ausente: «${written}»`);
});

test('a pantalla completa la barra sigue por encima del contenido', { timeout: 30_000 }, async () => {
  await page.click('#fullscreen');
  await page.waitForFunction(() => document.fullscreenElement?.id === 'player', { timeout: 5_000 });
  await new Promise((r) => setTimeout(r, 300));
  const hold = await grip();
  const onTop = await page.evaluate((x, y) => document.elementFromPoint(x, y)?.localName, hold.x, hold.y);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement, { timeout: 5_000 });
  assert.equal(onTop, 'lt-subtitles', 'la barra queda tapada por el elemento a pantalla completa');
});

test('la barra se puede sacar a una ventana flotante y devolver a la página', { timeout: CAPTION_TIMEOUT + 30_000 }, async (t) => {
  // Con la barra quieta (sin subtítulos entrando) los botones no se mueven bajo el ratón.
  await page.evaluate(() => document.getElementById('speech').pause());
  await waitInOverlay((root) => root.querySelector('.lt-caption').hidden, 20_000);
  const hold = await grip();
  await page.mouse.move(hold.x, hold.y);
  const button = await inOverlay((root) => {
    const r = root.querySelector('.lt-float-button').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(button.x, button.y);
  await page.waitForFunction(() => window.documentPictureInPicture?.window, { timeout: 10_000 });
  // Pase lo que pase, la ventana flotante no debe quedar abierta para las pruebas siguientes.
  t.after(() => page.evaluate(() => documentPictureInPicture.window?.close()).catch(() => {}));

  // Los subtítulos salen ahora en la ventana flotante, con el color elegido...
  await replay();
  await page.waitForFunction(
    () =>
      /agujeros negros/i.test(
        [...(documentPictureInPicture.window?.document.querySelectorAll('.lt-line') ?? [])].map((l) => l.textContent).join(' '),
      ),
    { timeout: CAPTION_TIMEOUT, polling: 250 },
  );
  const floating = await page.evaluate(() => {
    const text = documentPictureInPicture.window.document.querySelector('.lt-text');
    return { color: getComputedStyle(text).color, size: getComputedStyle(text).fontSize };
  });
  assert.equal(floating.color, 'rgb(255, 255, 255)');
  assert.equal(floating.size, '28px');
  // ...y no duplicados en la página, donde la barra avisa de dónde están.
  assert.equal(await inOverlay((root) => root.querySelector('.lt-text')), null);
  const onPage = await inOverlay((root) =>
    [...root.querySelectorAll('.lt-bar .lt-status')].filter((el) => el.getClientRects().length > 0).map((el) => el.textContent),
  );
  assert.deepEqual(onPage, ['Subtítulos en la ventana flotante']);
  const inWindow = await page.evaluate(() =>
    [...documentPictureInPicture.window.document.querySelectorAll('.lt-status')].filter((el) => el.getClientRects().length > 0).length,
  );
  assert.equal(inWindow, 0, 'en la ventana flotante se ve el estado junto al subtítulo');

  // Al cerrar la ventana flotante vuelven a la barra de la página.
  await page.evaluate(() => documentPictureInPicture.window.close());
  await waitInOverlay((root) => Boolean(root.querySelector('.lt-text')), 10_000);
  await replay();
  await waitForCaption(/agujeros negros/i);
});

test('la barra se arrastra con el ratón y recuerda dónde se dejó', { timeout: 60_000 }, async () => {
  // Con el subtítulo retirado la barra es pequeña y hay sitio para moverla
  // (una barra ancha no puede salirse de la ventana).
  await page.evaluate(() => document.getElementById('speech').pause());
  await waitInOverlay((root) => root.querySelector('.lt-caption').hidden, 20_000);

  const before = await barRect();
  const hold = await grip();
  await page.mouse.move(hold.x, hold.y);
  await page.mouse.down();
  await page.mouse.move(hold.x - 120, hold.y - 150, { steps: 8 });
  await page.mouse.move(hold.x - 250, hold.y - 300, { steps: 8 });
  await page.mouse.up();

  const moved = await barRect();
  assert.ok(Math.abs(moved.cx - (before.cx - 250)) < 6, `centro en ${moved.cx}, esperado ~${before.cx - 250}`);
  assert.ok(Math.abs(moved.bottom - (before.bottom - 300)) < 6, `base en ${moved.bottom}, esperado ~${before.bottom - 300}`);

  // Tras recargar la página la barra vuelve sola y en el mismo sitio.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('lt-subtitles')?.shadowRoot?.querySelector('.lt-bar'), {
    timeout: 20_000,
  });
  await waitInOverlay((root) => root.querySelector('.lt-bar').dataset.phase === 'listening', 30_000);
  const restored = await barRect();
  assert.ok(Math.abs(restored.cx - moved.cx) < 6, `tras recargar, centro en ${restored.cx}, esperado ~${moved.cx}`);
  assert.ok(Math.abs(restored.bottom - moved.bottom) < 6, `tras recargar, base en ${restored.bottom}`);
});

test('desde la barra se cambian el color, la fuente y el tamaño del texto', { timeout: 60_000 }, async () => {
  const hold = await grip();
  await page.mouse.move(hold.x, hold.y);
  const gear = await inOverlay((root) => {
    const r = root.querySelector('.lt-settings-button').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(gear.x, gear.y);
  await waitInOverlay((root) => !root.querySelector('.lt-panel').hidden, 5_000);

  // Color: muestra amarilla.
  const swatch = await inOverlay((root) => {
    const r = root.querySelector('.lt-swatch[title="Amarillo"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(swatch.x, swatch.y);
  // Fuente y tamaño: como lo haría el usuario con el desplegable y el deslizador.
  await inOverlay((root) => {
    const font = root.querySelector('select[id^="lt-fontFamily"]');
    font.value = 'mono';
    font.dispatchEvent(new Event('change', { bubbles: true }));
    const size = root.querySelector('input[id^="lt-fontSize"]');
    size.value = '40';
    size.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await waitInOverlay((root) => getComputedStyle(root.querySelector('.lt-text')).fontSize === '40px', 5_000);
  const style = await inOverlay((root) => {
    const s = getComputedStyle(root.querySelector('.lt-text'));
    return { color: s.color, fontFamily: s.fontFamily, fontSize: s.fontSize };
  });
  assert.equal(style.color, 'rgb(255, 225, 77)');
  assert.match(style.fontFamily, /Courier New/);
  assert.equal(style.fontSize, '40px');
});

test('al cambiar el idioma en la barra, la traducción sale en ese idioma', { timeout: CAPTION_TIMEOUT + 30_000 }, async () => {
  await inOverlay((root) => {
    const lang = root.querySelector('select[id^="lt-targetLang"]');
    lang.value = 'fr';
    lang.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await replay();
  await waitForCaption(/trous noirs/i);
});

test('al pasar a un vídeo en otro idioma, el idioma del audio se detecta de nuevo', { timeout: CAPTION_TIMEOUT + 60_000 }, async () => {
  // Hasta aquí todo el audio ha sido en inglés, así que ese idioma está
  // asentado y unas risas o una música no lo cambiarían. Otra página (otro
  // vídeo) sí puede estar en otro idioma: aquí, una locución en francés.
  await inExtensionPage(() => chrome.storage.local.set({ targetLang: 'es' }));
  await page.bringToFront();
  await page.goto(`${origin}/page.html?audio=fr`);
  await page.waitForFunction(() => document.querySelector('lt-subtitles')?.shadowRoot?.querySelector('.lt-bar'), {
    timeout: 20_000,
  });
  await waitInOverlay((root) => root.querySelector('.lt-bar').dataset.phase === 'listening', 30_000);
  await replay();
  await waitForCaption(/cocina francesa/i);
});

test('si no se puede traducir, la barra lo avisa en vez de callar', { timeout: 2 * CAPTION_TIMEOUT + 90_000 }, async () => {
  // Inglés → alemán solo con el traductor en línea, que (el de pega) responde 429 a ese idioma.
  // Se fuerza ese motor porque Chrome puede activar por su cuenta el paquete local en cualquier momento.
  await inExtensionPage(() => chrome.storage.local.set({ targetLang: 'de', engine: 'google' }));
  await page.bringToFront();
  // De vuelta a la página en inglés: el idioma del audio solo se vuelve a
  // detectar al cambiar de página (dentro de una misma se mantiene a propósito).
  await page.goto(`${origin}/page.html?audio=en`);
  await page.waitForFunction(() => document.querySelector('lt-subtitles')?.shadowRoot?.querySelector('.lt-bar'), {
    timeout: 20_000,
  });
  await waitInOverlay((root) => root.querySelector('.lt-bar').dataset.phase === 'listening', 30_000);
  await replay('en.wav');
  await waitInOverlay((root) => root.querySelector('.lt-warning')?.getClientRects().length > 0, CAPTION_TIMEOUT);
  const warning = await inOverlay((root) => root.querySelector('.lt-warning').textContent);
  assert.match(warning, /no se puede traducir/i);
  // Mientras tanto se muestra lo que se dice, sin traducir.
  await waitForCaption(/black holes/i);

  // El botón del aviso abre el popup de la extensión, que es donde se explica y se arregla.
  for (const open of await extension.pages()) {
    if (open.url().includes('popup/popup.html')) await open.close();
  }
  const button = await inOverlay((root) => {
    const r = root.querySelector('.lt-warning button').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(button.x, button.y);
  const opened = await popupPage();
  await opened.waitForFunction(() => !document.getElementById('notice').hidden, { timeout: 10_000 });
  assert.match(await opened.$eval('#notice-text', (el) => el.textContent), /sin traducir/);

  // El traductor en línea no debe recibir una ráfaga de peticiones: tras el 429 se le deja en paz.
  const toGerman = google.requests.filter((r) => r.target === 'de').length;
  assert.ok(toGerman <= 2, `se han hecho ${toGerman} peticiones al traductor saturado`);

  // Al volver a un idioma que sí se puede traducir, el aviso desaparece.
  await inExtensionPage(() => chrome.storage.local.set({ targetLang: 'es', engine: 'auto' }));
  await page.bringToFront();
  let cleared = false;
  for (let attempt = 0; attempt < 8 && !cleared; attempt++) {
    await replay('en.wav');
    cleared = await waitInOverlay((root) => root.querySelector('.lt-warning').getClientRects().length === 0, 10_000).then(
      () => true,
      () => false,
    );
  }
  assert.ok(cleared, 'el aviso sigue en pantalla aunque ya se puede traducir');
});

test('la barra también aparece en páginas que exigen Trusted Types, como YouTube', { timeout: 60_000 }, async () => {
  // En estas páginas no valen waitForFunction ni new Function: se sondea a mano.
  const phase = () =>
    page.evaluate(() => document.querySelector('lt-subtitles')?.shadowRoot?.querySelector('.lt-bar')?.dataset.phase ?? null);
  await page.goto(`${origin}/page.html?audio=en&tt=1`);
  let seen = null;
  for (let i = 0; i < 80 && seen !== 'listening'; i++) {
    seen = await phase();
    await new Promise((r) => setTimeout(r, 250));
  }
  const strict = await page.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<b>x</b>';
      return false;
    } catch {
      return true;
    }
  });

  // De vuelta a la página normal para las pruebas siguientes.
  await page.goto(`${origin}/page.html?audio=en`);
  await page.waitForFunction(() => document.querySelector('lt-subtitles')?.shadowRoot?.querySelector('.lt-bar'), {
    timeout: 20_000,
  });

  assert.equal(strict, true, 'la página de prueba no está aplicando Trusted Types');
  assert.equal(seen, 'listening', 'la barra no ha aparecido en la página con Trusted Types');
});

test('el botón de cerrar de la barra detiene la traducción y la quita', { timeout: 30_000 }, async () => {
  const hold = await grip();
  await page.mouse.move(hold.x, hold.y);
  const close = await inOverlay((root) => {
    const r = root.querySelector('.lt-stop-button').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(close.x, close.y);
  await page.waitForFunction(() => !document.querySelector('lt-subtitles'), { timeout: 10_000 });

  const contexts = await inExtensionPage(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(contexts.length, 0, 'el documento de captura debería haberse cerrado');
});
