#!/usr/bin/env node
/**
 * End-to-end test: load the built extension (dist/) into Chromium with Playwright, set the API
 * key, and drive it with the SAME messages the side panel sends — word-by-word partial
 * transcripts (simulated speech) and one typed command through the real side panel UI — against
 * real websites. Asserts URL / scroll / tab outcomes and prints per-step Jev latency + total cost
 * like the original voice-browser demo.
 *
 *   npm run test:e2e                 # headless (new headless via channel "chromium")
 *   npm run test:e2e:headed          # watch it
 *   node test/e2e/extension.e2e.mjs --only 1,2,3 --word-ms 250 --debug
 *
 * Steps build on each other (e.g. 8 "click the more information link" expects to be on example.com
 * from step 7), so `--only` is for debugging a prefix of the script, not arbitrary subsets.
 *
 * Needs TYPESAFE_API_KEY (or JEV_API_KEY) in the environment. The key is written to the
 * extension's chrome.storage.local inside the throw-away profile and never printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MSG, PORT_NAME } from "../../src/protocol.js";
import { MODEL } from "../../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "..", "dist");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const HEADED = args.includes("--headed");
const DEBUG = args.includes("--debug") || Boolean(process.env.VB_DEBUG);
const WORD_MS = Number(flag("--word-ms", 280));
const ONLY = flag("--only", null) ? String(flag("--only")).split(",").map(Number) : null;
const API_KEY = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "";

if (!API_KEY) {
  console.error("Missing TYPESAFE_API_KEY (or JEV_API_KEY). Export it first.");
  process.exit(1);
}
if (!fs.existsSync(path.join(DIST, "manifest.json"))) {
  console.error("dist/ not built. Run `npm run build` first.");
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

/** The scripted run. `expect(state)` returns truthy when the step succeeded. */
const STEPS = [
  { say: "go to wikipedia", expect: (s) => s.url.includes("wikipedia.org") },
  { say: "search for alan turing", expect: (s) => /Alan_Turing|search=alan/i.test(s.url) },
  { say: "scroll down a bit", expect: (s) => s.scrollY > 50 },
  { say: "scroll to the bottom", expect: (s) => s.scrollY > 2000 },
  { say: "scroll up a page", expect: (s) => s.scrollY != null }, // must execute
  { say: "go back", expect: (s) => s.url.includes("wikipedia.org") && !/Alan_Turing|search=/.test(s.url) },
  { say: "open example dot com", expect: (s) => s.url.includes("example.com") },
  { say: "click the more information link", expect: (s) => s.url.includes("iana.org") },
  // Correction: rejects the click just made → policy reverses it (go back) using the per-tab context.
  { say: "no not that one", expect: (s) => s.url.includes("example.com") && !s.url.includes("iana.org"), correction: true },
  // Typed through the real side panel UI (text-command fallback).
  { say: "go to hacker news", viaUi: true, expect: (s) => s.url.includes("news.ycombinator.com") },
  { say: "click the new link", expect: (s) => s.url.includes("news.ycombinator.com/newest") },
  {
    say: "click on a link please",
    // Ambiguous on purpose: numbered candidate badges appear in the page and a spoken number picks
    // one (no model call). If Jev happens to be confident it just clicks — both count.
    followUpOnCandidates: "two",
    // Pass when a click was executed on the chosen candidate: either the URL changed, or the
    // chosen link points at the page we are already on (HN's "new" → /newest).
    expect: (s) => {
      const a = s.context?.recentActions?.at(-1);
      return Boolean(a && a.type === "click_element" && (/^navigated/.test(a.outcome) || !/news\.ycombinator\.com\/newest$/.test(s.url) || /"new"/.test(a.targetLabel || "")));
    },
  },
  { say: "search duckduckgo for typesafe jev", expect: (s) => /duckduckgo\.com\/\?q=typesafe(%20|\+)jev/.test(s.url) },
  { say: "open a new tab", expect: (s) => s.tabCount === 2 },
  { say: "close this tab", expect: (s) => s.tabCount === 1 },
  // Two commands in one breath: the first executes as soon as it is complete, the rest becomes a new command.
  { say: "go to example dot com and click the more information link", multi: true, expect: (s) => s.url.includes("iana.org") },
  { say: "so anyway I think we should get lunch", expectNoAction: true, expect: () => true },
];

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-ext-e2e-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !HEADED,
    channel: "chromium", // required for extensions in headless mode (Playwright docs)
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--use-fake-ui-for-media-stream", // auto-accept the mic prompt → lets us exercise permission.html
      "--use-fake-device-for-media-stream",
    ],
  });

  // MV3 service worker of the extension
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = sw.url().split("/")[2];
  await waitFor(() => sw.evaluate(() => Boolean(globalThis.__vbApp)), { timeout: 10000 });

  // Put the API key where the options page would (chrome.storage.local). Never printed.
  await sw.evaluate((key) => chrome.storage.local.set({ apiKey: key }), API_KEY);

  // --- pre-step A: mic permission page (extension page in a tab). With the fake-UI flag the
  // prompt auto-accepts, so this verifies the getUserMedia plumbing of permission.html.
  const permPage = await context.newPage();
  await permPage.goto(`chrome-extension://${extensionId}/permission.html`);
  const micResult = await waitFor(() => permPage.evaluate(() => (window.__vbMicGranted ? "granted" : window.__vbMicError || null)), { timeout: 8000 });
  const permClosed = await waitFor(() => Promise.resolve(permPage.isClosed()), { timeout: 4000 });
  console.log(`mic permission page: ${micResult === "granted" ? "✓ getUserMedia granted" : `✗ ${micResult}`}${permClosed ? ", tab closed itself" : ""}`);
  if (!permPage.isClosed()) await permPage.close();

  // --- pre-step B: side panel page opened as a tab (headless has no side panel chrome); it is
  // the real UI, connected to the worker over the real port.
  const panel = context.pages()[0] || (await context.newPage());
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await waitFor(() => panel.evaluate(() => document.getElementById("ws")?.textContent === "connected" && /key/.test(document.getElementById("apikey")?.textContent || "")), { timeout: 8000 });
  const keyPill = await panel.evaluate(() => document.getElementById("apikey").textContent);
  const speechApi = await panel.evaluate(() => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  console.log(`side panel: ${await panel.evaluate(() => document.getElementById("ws").textContent)} · ${keyPill.replace(/[A-Za-z0-9]{4}(?=\s|$)/, "****")} · Web Speech API ${speechApi ? "available" : "NOT available"}`);
  // Collect worker → panel events through a second port (same protocol the panel uses).
  await panel.evaluate((portName) => {
    window.__events = [];
    const p = chrome.runtime.connect({ name: portName });
    p.onMessage.addListener((m) => window.__events.push(m));
  }, PORT_NAME);

  // --- the controlled tab
  const controlled = await context.newPage();
  await controlled.goto("about:blank");
  await controlled.bringToFront();
  await sleep(400);

  const send = (msg) => panel.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const events = () => panel.evaluate(() => window.__events.splice(0));
  const state = () =>
    sw.evaluate(async () => {
      const app = globalThis.__vbApp;
      const id = app.browser.activeTabId;
      const tab = id != null ? await chrome.tabs.get(id).catch(() => null) : null;
      let scrollY = null;
      if (tab && /^https?:/.test(tab.url || "")) {
        try {
          const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => Math.round(window.scrollY) });
          scrollY = r?.result ?? null;
        } catch {}
      }
      const tabs = (await chrome.tabs.query({})).filter((t) => !(t.url || "").startsWith(`chrome-extension://${chrome.runtime.id}/`));
      const ui = app.controller.uiState();
      return { url: tab?.url || "", scrollY, tabCount: tabs.length, actions: ui.stats.actions, stats: ui.stats, candidates: ui.candidates, pending: ui.pending, context: ui.context, log: ui.log.slice(-12) };
    });

  console.log(`\nvoice-browser-extension e2e · model ${MODEL} · ${HEADED ? "headed" : "headless"} Chromium · extension ${extensionId} · ${WORD_MS}ms per spoken word\n`);

  const results = [];
  let stepNo = 0;
  for (const step of STEPS) {
    stepNo += 1;
    if (ONLY && !ONLY.includes(stepNo)) continue;
    results.push(await runStep(step, stepNo, { send, events, state, panel }));
    await sleep(500);
  }

  // ---- summary
  const s = (await state()).stats;
  console.log("\n" + "─".repeat(104));
  console.log("step  result  acted@word  jev(ms)  word→decision(ms)  word→done(ms)  phrase");
  for (const r of results) {
    console.log(
      `${String(r.no).padStart(3)}   ${r.ok ? " PASS " : " FAIL "}  ${String(r.actedAt ?? "-").padStart(9)}  ${String(r.latency ?? "-").padStart(7)}  ${String(r.cmdToDecide ?? "-").padStart(17)}  ${String(r.cmdToAct ?? "-").padStart(13)}  "${r.say}"${r.note ? `  (${r.note})` : ""}`,
    );
  }
  const passed = results.filter((r) => r.ok).length;
  const decided = results.map((r) => r.cmdToDecide).filter((x) => x != null);
  const avgDecide = decided.length ? Math.round(decided.reduce((a, b) => a + b, 0) / decided.length) : "-";
  console.log("─".repeat(104));
  console.log(
    `${passed}/${results.length} steps passed · ${s.calls} Jev calls · Jev latency avg ${s.avgLatencyMs} ms, p50 ${s.p50LatencyMs} ms · last word→decision avg ${avgDecide} ms · last word→action done avg ${s.avgCommandToActionMs} ms (includes page loads) · ${s.inputTokens} input tokens · $${s.costUsd.toFixed(5)} total`,
  );
  console.log("(word→decision includes the 200 ms debounce; acted@word < total means the browser acted before the sentence ended)");

  if (HEADED) {
    console.log("\nLeaving the window open for 6 s…");
    await sleep(6000);
  }
  await context.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  process.exit(passed === results.length && micResult === "granted" ? 0 : 1);
}

/**
 * Feed a phrase word by word as partial transcripts (or type it into the side panel); resolve
 * when the extension acts (or shows candidates / asks for confirmation), then check the outcome.
 */
async function runStep(step, no, { send, events, state, panel }) {
  const words = step.say.split(" ");
  const utteranceId = `e2e-${no}`;
  const before = await state();
  let actedAt = null;
  let latency = null;
  let cmdToAct = null;
  let cmdToDecide = null;
  let candidates = null;
  let pending = null;
  let done = false;
  let firstAction = null;

  await events(); // drain
  const poll = async () => {
    for (const ev of await events()) {
      if (ev.type === MSG.ACTION && !firstAction) {
        firstAction = ev.payload;
        cmdToAct = ev.payload.sinceLastWordMs;
        cmdToDecide = ev.payload.decisionMs;
      }
      if (ev.type === MSG.DECISION && ev.payload.policy?.decision === "act") latency = ev.payload.latencyMs;
      if (ev.type === MSG.CANDIDATES) candidates = ev.payload;
      if (ev.type === MSG.PENDING && ev.payload) pending = ev.payload;
    }
    const st = await state();
    if (st.actions > before.actions) done = true;
    return st;
  };

  process.stdout.write(`${no}. "${step.say}" `);
  if (step.viaUi) {
    await panel.bringToFront();
    await panel.fill("#cmd", step.say);
    await panel.press("#cmd", "Enter");
    process.stdout.write("[typed in side panel] ");
  } else {
    for (let i = 0; i < words.length; i++) {
      const partial = words.slice(0, i + 1).join(" ");
      if (done && !step.multi) break;
      await send({ type: MSG.TRANSCRIPT, text: partial, final: false, utteranceId });
      process.stdout.write(".");
      await sleep(WORD_MS);
      await poll();
      if (done && actedAt == null) actedAt = `${i + 1}/${words.length}`;
    }
    if (!done || step.multi) {
      await sleep(300);
      await send({ type: MSG.TRANSCRIPT, text: step.say, final: true, utteranceId });
    }
  }

  const outcome = await waitFor(
    async () => {
      await poll();
      return done || candidates || pending;
    },
    { timeout: 14000 },
  );
  if (done && actedAt == null) actedAt = `${words.length}/${words.length}`;

  if (!done && candidates && step.followUpOnCandidates) {
    process.stdout.write(` [${candidates.length} candidates → say "${step.followUpOnCandidates}"]`);
    await sleep(600);
    await send({ type: MSG.TRANSCRIPT, text: step.followUpOnCandidates, final: true, utteranceId: `${utteranceId}-pick` });
    await waitFor(
      async () => {
        await poll();
        return done;
      },
      { timeout: 8000 },
    );
  }

  let ok;
  let note = "";
  let st = await state();
  if (step.expectNoAction) {
    await sleep(1500);
    st = await poll();
    ok = !done && !candidates && !pending;
    note = ok ? "correctly ignored" : "should not have acted";
  } else {
    if (step.multi) {
      // wait for the second command of the same breath
      await waitFor(
        async () => {
          st = await poll();
          return st.actions >= before.actions + 2 || step.expect(st);
        },
        { timeout: 14000 },
      );
    }
    ok = Boolean(
      await waitFor(
        async () => {
          st = await state();
          return step.expect(st);
        },
        { timeout: 8000 },
      ),
    );
    if (!outcome) note = "no action within timeout";
    if (step.correction && ok) note = `correction reversed: ${firstAction?.action?.type || "?"}`;
    if (step.followUpOnCandidates && ok) note = candidates ? `disambiguated by number → ${st.context?.recentActions?.at(-1)?.targetLabel || "?"}` : "Jev was confident, clicked directly";
  }
  console.log(` ${ok ? "✓" : "✗"} ${st.url}${st.scrollY != null && /scroll/.test(step.say) ? ` scrollY=${st.scrollY}` : ""}${/tab/.test(step.say) ? ` tabs=${st.tabCount}` : ""}${note ? ` (${note})` : ""}`);
  if (!ok || DEBUG) for (const e of st.log.slice(-(DEBUG ? 12 : 6))) console.log(`      [${e.level}] ${e.msg}`);
  return { no, say: step.say, ok, actedAt, latency, cmdToAct, cmdToDecide, note };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
