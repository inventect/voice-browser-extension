#!/usr/bin/env node
/**
 * Capture a page snapshot fixture for tests (compact snapshot as sent to Jev, without rawById).
 *
 *   node scripts/capture-fixture.mjs <url|pages/modal.html> <name> [--click <selector>] [--scroll <selector>]
 *
 * Local test pages under test/e2e/pages are served on a random port when the url starts with "pages/".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { collectElementsInPage, buildSnapshot } from "../src/snapshot.js";
import { servePages } from "../test/e2e/serve-pages.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const [target, name] = args;
if (!target || !name) {
  console.error("usage: node scripts/capture-fixture.mjs <url|pages/x.html> <name> [--click sel] [--scroll sel]");
  process.exit(1);
}
const opt = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);

const srv = target.startsWith("pages/") ? await servePages() : null;
const url = srv ? `${srv.url}/${target.slice("pages/".length)}` : target;
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(600);
if (opt("--click")) await page.click(opt("--click"));
if (opt("--scroll")) await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView(), opt("--scroll"));
await page.waitForTimeout(200);
const data = await page.evaluate(collectElementsInPage);
const snap = buildSnapshot(data);
delete snap.rawById;
// keep fixtures location-independent
const origin = new URL(url).origin;
const scrub = (s) => (typeof s === "string" ? s.replace(origin, "https://example-test.local") : s);
snap.url = scrub(snap.url);
if (snap.elements) for (const e of snap.elements) if (e.href) e.href = e.href.replace(/^127\.0\.0\.1:\d+/, "example-test.local");
const out = path.join(__dirname, "..", "test", "fixtures", `${name}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...snap, rawCount: data.elements.length }, null, 2));
console.log(`${out}: ${snap.elements.length} elements (raw ${data.elements.length}), searchBox=${snap.searchBoxId}, site=${snap.site}, popup=${JSON.stringify(snap.popup)}`);
await browser.close();
if (srv) await srv.close();
