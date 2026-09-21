#!/usr/bin/env node
/**
 * Rasterise assets/icon.svg → assets/icons/icon{16,32,48,128}.png with Playwright's Chromium.
 * Run once after changing the SVG (`npm run icons`); `npm run build` copies the PNGs into dist/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "assets", "icon.svg"), "utf8");
const outDir = path.join(root, "assets", "icons");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: path.join(outDir, `icon${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`assets/icons/icon${size}.png`);
}
await browser.close();
