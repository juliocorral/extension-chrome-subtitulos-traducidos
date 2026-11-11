// Genera los PNG del icono a partir de extension/icons/icon.svg usando Chrome.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const icons = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const svg = await readFile(join(icons, 'icon.svg'), 'utf8');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await writeFile(join(icons, `icon${size}.png`), await page.screenshot({ omitBackground: true }));
    console.log(`icons/icon${size}.png`);
  }
} finally {
  await browser.close();
}
