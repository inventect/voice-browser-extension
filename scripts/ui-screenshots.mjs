#!/usr/bin/env node
/**
 * Visual check: load dist/ into headless Chromium and screenshot the side panel (400×800, light +
 * dark, empty state + after a few commands), the settings page, the permission page and the
 * in-page overlay (highlight, toast, candidate badges) into reports/ui/.
 *
 *   TYPESAFE_API_KEY=… node scripts/ui-screenshots.mjs   (without a key the "missing key" state is captured)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { servePages } from "../test/e2e/serve-pages.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const DIST = path.join(root, "dist");
const OUT = process.env.VB_SHOTS_DIR || path.join(root, "reports", "ui");
fs.mkdirSync(OUT, { recursive: true });
const KEY = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const local = await servePages();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vb-shots-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
await sleep(400);

const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: opts.fullPage ?? false });
  console.log(`reports/ui/${name}.png`);
};
// wait out the 0.2–0.35 s colour transitions, or the capture shows half-switched colours
const setScheme = async (page, scheme) => {
  await page.emulateMedia({ colorScheme: scheme });
  await sleep(500);
};

// --- side panel: missing key (before a key is set), light
const panel = ctx.pages()[0];
await panel.setViewportSize({ width: 400, height: 800 });
await panel.goto(`chrome-extension://${id}/sidepanel.html`);
await sleep(600);
await setScheme(panel, "light");
await shot(panel, "sidepanel-missing-key-light");

if (KEY) await sw.evaluate((k) => chrome.storage.local.set({ apiKey: k }), KEY);
await panel.reload();
await sleep(600);
await setScheme(panel, "light");
await shot(panel, "sidepanel-empty-light");
await setScheme(panel, "dark");
await shot(panel, "sidepanel-empty-dark");
// English copy (segmented control), then back to Korean
await panel.click('#lang button[data-lang="en-US"]');
await sleep(300);
await setScheme(panel, "light");
await shot(panel, "sidepanel-empty-light-en");
await panel.click('#lang button[data-lang="ko-KR"]');
await sleep(300);

// --- a controlled tab with a real page + a pop-up, then drive a few commands through the panel UI
const page = await ctx.newPage();
await page.goto(`${local.url}/modal.html`);
await page.bringToFront();
await sleep(500);
if (KEY) {
  const run = async (text, wait = 3200) => {
    await panel.fill("#cmd", text);
    await panel.press("#cmd", "Enter");
    await sleep(wait);
  };
  await run("팝업 닫아 줘");
  await run("쿠키 동의해 줘");
  await run("위키피디아로 가 줘", 4500);
  await run("링크 눌러 줘", 3500); // likely ambiguous → numbered badges + "which one?" card
  await setScheme(panel, "light");
  await shot(panel, "sidepanel-conversation-light");
  await setScheme(panel, "dark");
  await shot(panel, "sidepanel-conversation-dark");
  // overlay on the page: candidate badges are up (8 s TTL) — capture, then highlight + toast
  await page.bringToFront();
  await shot(page, "overlay-candidates");
  await sw.evaluate(async () => {
    const app = globalThis.__vbApp;
    const el = app.controller.snapshot.elements.find((e) => e.role === "link") || app.controller.snapshot.elements[0];
    await app.browser.overlay("clearCandidates");
    await app.browser.overlay("highlight", el.id, 4000);
    await app.browser.overlay("toast", `Clicked “${el.text}”`, 4000);
  });
  await sleep(400);
  await shot(page, "overlay-highlight-toast");
  // details expanded (developer view)
  await panel.bringToFront();
  await panel.evaluate(() => (document.getElementById("details").open = true));
  await sleep(200);
  await setScheme(panel, "light");
  await shot(panel, "sidepanel-details-light", { fullPage: true });
  // listening state (mic on) — Web Speech starts in the fake-device Chromium, no network recognizer
  await panel.click("#micbtn");
  await sleep(1500);
  await panel.evaluate(() => (document.getElementById("details").open = false));
  await panel.evaluate(() => window.scrollTo(0, 0));
  await setScheme(panel, "dark");
  await shot(panel, "sidepanel-listening-dark");
} else {
  console.log("(no TYPESAFE_API_KEY: skipping conversation / overlay screenshots)");
}

// --- options + permission
const opt = await ctx.newPage();
await opt.setViewportSize({ width: 900, height: 1000 });
await opt.goto(`chrome-extension://${id}/options.html`);
await sleep(500);
if (KEY) {
  await opt.click("#test");
  await sleep(2500);
}
await setScheme(opt, "light");
await shot(opt, "options-light", { fullPage: true });
await setScheme(opt, "dark");
await opt.evaluate(() => (document.getElementById("advanced").open = true));
await shot(opt, "options-advanced-dark", { fullPage: true });

const perm = await ctx.newPage();
await perm.setViewportSize({ width: 900, height: 700 });
// reason=denied keeps the page from auto-requesting (and auto-closing) so it can be captured
await perm.goto(`chrome-extension://${id}/permission.html?reason=denied`);
await sleep(400);
await setScheme(perm, "light");
await shot(perm, "permission-light");

await ctx.close();
await local.close();
fs.rmSync(profile, { recursive: true, force: true });
