#!/usr/bin/env node
/**
 * Voice end-to-end with ElevenLabs (local addition, not upstream).
 *
 * Loads the built extension (dist/) into Playwright Chromium whose microphone is a WAV file:
 * Korean commands synthesised with macOS `say`, separated by silence. The REAL side panel code
 * captures that "mic" through getUserMedia → AudioWorklet → ElevenLabs Scribe v2 Realtime (token
 * minted by the service worker) → transcripts → Jev → actions on local test pages. Nothing is
 * injected as text: every action has to come out of the audio.
 *
 *   TYPESAFE_API_KEY=… ELEVENLABS_API_KEY=… node test/e2e/voice-el.e2e.mjs [--headed] [--degrade]
 *
 * Keys go into the throw-away profile's chrome.storage.local and are never printed.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { synth, writeWav, tmpDir } from "../../scripts/lib-audio.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "..", "dist");
const args = process.argv.slice(2);
const HEADED = args.includes("--headed");
const DEGRADE = args.includes("--degrade");
const JEV_KEY = process.env.TYPESAFE_API_KEY || "";
const EL_KEY = process.env.ELEVENLABS_API_KEY || "";
if (!JEV_KEY || !EL_KEY) {
  console.error("Need TYPESAFE_API_KEY and ELEVENLABS_API_KEY in the environment.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, every = 150 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

// ---- a small Korean "portal" with Naver-like menu labels, plus two target pages
const PORTAL = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>테스트 포털</title>
<style>body{font:16px system-ui;margin:24px} nav a{margin-right:14px} .tall{height:2600px}</style>
<h1>테스트 포털</h1>
<nav><a href="/mail">메일</a><a href="/cafe">카페</a><a href="/blog">블로그</a><a href="/shopping-live">쇼핑라이브</a><a href="/news">뉴스</a><a href="/webtoon">웹툰</a><a href="/map">지도</a></nav>
<form action="/search"><input name="q" placeholder="검색어를 입력해 주세요" aria-label="검색"><button>검색</button></form>
<p class="tall">본문</p></html>`;
const PAGE = (t) => `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${t}</title><h1>${t}</h1><p>${t} 페이지</p><a href="/">홈</a></html>`;

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (u.pathname === "/") return res.end(PORTAL);
      const names = { "/mail": "메일", "/cafe": "카페", "/blog": "블로그", "/shopping-live": "쇼핑라이브", "/news": "뉴스", "/webtoon": "웹툰", "/map": "지도" };
      if (u.pathname === "/search") return res.end(PAGE(`검색 결과: ${u.searchParams.get("q") || ""}`));
      res.end(PAGE(names[u.pathname] || "없음"));
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

// Spoken script. Each command waits for the previous action to finish (the audio has long gaps).
const SCRIPT = [
  { say: "메일 눌러 줘", expect: (s) => s.url.endsWith("/mail") },
  { say: "뒤로 가", expect: (s) => /\/$/.test(s.url) },
  { say: "쇼핑 라이브 클릭해 줘", expect: (s) => s.url.endsWith("/shopping-live") },
  { say: "뒤로 가", expect: (s) => /\/$/.test(s.url) },
  { say: "조금 아래로 스크롤해 줘", expect: (s) => s.scrollY > 50 },
  { say: "카페 들어가 줘", expect: (s) => s.url.endsWith("/cafe") },
];
const GAP_S = 5.5; // silence after each command: VAD commit (~1 s) + Jev + action + page load

async function main() {
  const dir = tmpDir("vb-voice-e2e-");
  const RATE = 16000;
  const LEAD_S = 4.0; // time to open the panel and press the mic before the first word
  const parts = [];
  const marks = [];
  let cursor = Math.round(LEAD_S * RATE);
  for (const [i, st] of SCRIPT.entries()) {
    const pcm = synth(st.say, { degrade: DEGRADE, dir, seed: 99 + i });
    marks.push({ start: cursor / RATE, end: (cursor + pcm.length) / RATE });
    parts.push({ at: cursor, pcm });
    cursor += pcm.length + Math.round(GAP_S * RATE);
  }
  const total = new Int16Array(cursor + RATE);
  for (const p of parts) total.set(p.pcm, p.at);
  const wav = path.join(dir, "mic.wav");
  writeWav(wav, total, RATE);
  const audioS = total.length / RATE;

  const site = await serve();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-voice-profile-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !HEADED,
    channel: "chromium",
    viewport: { width: 1200, height: 860 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = sw.url().split("/")[2];
  await waitFor(() => sw.evaluate(() => Boolean(globalThis.__vbApp)), { timeout: 10000 });
  await sw.evaluate(([j, e]) => chrome.storage.local.set({ apiKey: j, elevenLabsKey: e }), [JEV_KEY, EL_KEY]);

  // grant the mic for the extension origin (permission page), like a first run
  const perm = await context.newPage();
  await perm.goto(`chrome-extension://${extensionId}/permission.html`);
  await waitFor(() => perm.evaluate(() => window.__vbMicGranted || window.__vbMicError || null).catch(() => "closed"), { timeout: 8000 });
  if (!perm.isClosed()) await perm.close().catch(() => {});

  const controlled = await context.newPage();
  await controlled.goto(`${site.url}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await waitFor(() => panel.evaluate(() => document.getElementById("conntext")?.textContent === "ready"), { timeout: 8000 });
  await controlled.bringToFront();
  await sleep(300);
  // snapshot of the portal so keyterms reflect it
  await sw.evaluate(async () => {
    const app = globalThis.__vbApp;
    await app.controller.refreshSnapshot();
  });

  // press the mic (the button handler is the real one). The recogniser runs in the offscreen
  // document; the worker reports when its capture device started (= t0 of the WAV) so actions can
  // be timed against the end of each spoken command.
  const tMic = Date.now();
  await panel.evaluate(() => document.getElementById("micbtn").click());
  const engine = await waitFor(() => panel.evaluate(() => document.getElementById("sttengine")?.textContent || "").then((t) => (t && t !== "–" && !/\(off\)$/.test(t) ? t : null)), { timeout: 10000 });
  // Local addition: listening must survive closing the side panel — close it right away and
  // reopen it only after the audio is over.
  const CLOSE_PANEL = !args.includes("--keep-panel");
  if (CLOSE_PANEL) {
    await panel.close();
    console.log("side panel closed while listening (reopened after the audio)");
  }
  console.log(`\nvoice e2e · ${DEGRADE ? "DEGRADED" : "clean"} synthesized Korean audio (${audioS.toFixed(1)} s) · engine: ${engine || "?"} · mic pressed ${((Date.now() - tMic) / 1000).toFixed(1)} s in\n`);

  // follow along until the audio is over + slack
  const deadline = Date.now() + (audioS + 8) * 1000;
  while (Date.now() < deadline) await sleep(500);
  const gumAt = await sw.evaluate(() => globalThis.__vbApp.micState().audioAt || null);
  const micWasOn = await sw.evaluate(() => globalThis.__vbApp.micState().on);
  let panelNow = panel;
  if (CLOSE_PANEL) {
    panelNow = await context.newPage();
    await panelNow.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await waitFor(() => panelNow.evaluate(() => document.getElementById("conntext")?.textContent === "ready"), { timeout: 8000 });
    await sleep(300);
  }
  const panelMicOn = await panelNow.evaluate(() => document.getElementById("micbtn").getAttribute("aria-pressed") === "true");
  console.log(`after the audio: mic ${micWasOn ? "still on" : "OFF"} in the worker · reopened panel shows it ${panelMicOn ? "on" : "off"}`);
  // executed actions only (the controller logs "✓ …" / "✗ …" once per action)
  const acted = await sw.evaluate(() => globalThis.__vbApp.controller.uiState().log.filter((l) => /^[✓✗] /.test(l.msg)).map((l) => ({ t: l.t, msg: l.msg })));
  const speech = await panelNow.evaluate(() => [...document.querySelectorAll("#speechlog div")].map((d) => d.textContent));
  await panelNow.evaluate(() => document.getElementById("micbtn").click()); // stop mic
  await sleep(400);
  const offscreenLeft = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);
  console.log(`mic stopped · offscreen documents left: ${offscreenLeft}`);

  // Score: the i-th spoken command should produce an action that satisfies SCRIPT[i].expect —
  // checked through the URL / scroll recorded in the action log line.
  const finals = speech.filter((l) => /final/.test(l) && /elevenlabs\)$/.test(l)).map((l) => l.replace(/^.*“(.*)”.*$/, "$1"));
  console.log("ElevenLabs final transcripts:");
  finals.forEach((f, i) => console.log(`  ${i + 1}. “${f}”   (said “${SCRIPT[i]?.say ?? "?"}”)`));
  console.log("\nActions executed (time = from the end of the spoken command to the finished action):");
  const lat = [];
  acted.forEach((a, i) => {
    let when = "";
    if (gumAt) {
      // attribute the action to the latest command that ended before it
      const rel = (a.t - gumAt) / 1000;
      const k = marks.map((m, j) => (m.end <= rel ? j : -1)).filter((j) => j >= 0).at(-1);
      if (k != null) {
        const ms = Math.round((rel - marks[k].end) * 1000);
        a.cmd = k;
        a.ms = ms;
        lat.push(ms);
        when = ` [cmd ${k + 1} “${SCRIPT[k].say}” → +${ms} ms]`;
      }
    }
    console.log(`  ${i + 1}. ${a.msg}${when}`);
  });
  const st = await sw.evaluate(() => globalThis.__vbApp.controller.uiState().stats);
  console.log("\nPer command:");
  let ok = 0;
  SCRIPT.forEach((s, k) => {
    const a = acted.find((x) => x.cmd === k);
    const m = a?.msg || "";
    const url = (m.match(/https?:\/\/\S+/) || [""])[0];
    const scrollY = Number((m.match(/scrollY=(\d+)/) || [])[1] ?? 0);
    const pass = m.startsWith("✓") && s.expect({ url, scrollY });
    if (pass) ok += 1;
    console.log(`  ${pass ? "✓" : "✗"} ${k + 1}. “${s.say}” → ${a ? a.msg.replace(/ — decided.*?(https?:\/\/\S+|scrollY=\d+).*$/, " → $1") : "(no action)"}`);
  });
  const sorted = [...lat].sort((a, b) => a - b);
  console.log(`\nRESULT ${ok}/${SCRIPT.length} spoken commands did the right thing · actions ${st.actions} · Jev calls ${st.calls} · cost $${(st.costUsd || 0).toFixed(4)} · speech-end→done median ${sorted.length ? sorted[Math.floor(sorted.length / 2)] : "–"} ms (min ${sorted[0] ?? "–"}, max ${sorted.at(-1) ?? "–"})`);
  const sess = speech.filter((l) => /elevenlabs (open|stopped)|could not open|closed/.test(l));
  console.log(`scribe sessions: ${sess.map((l) => l.replace(/^\S+\s+\S+\s+\S+\s+/, "")).join(" | ")}`);
  const errors = speech.filter((l) => /error|failed/.test(l));
  if (errors.length) console.log(`speech errors: ${errors.join(" | ")}`);

  fs.writeFileSync(path.join(process.env.TMPDIR || os.tmpdir(), `vb-voice-e2e${DEGRADE ? "-degraded" : ""}.json`), JSON.stringify({ engine, finals, acted, speech, stats: st, lat }, null, 1));
  await context.close();
  site.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("FAILED:", e.stack || e.message || e);
  process.exit(1);
});
