// Local addition (not upstream): the worker-owned microphone. The recognisers run in an offscreen
// document (faked here as `micHost`), so listening survives closing the side panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChromeShim, rawEl } from "../helpers/chrome-shim.js";
import { createApp } from "../../src/app.js";
import { execute } from "../../src/executor.js";
import { mockDecide } from "../helpers/mock-jev.js";
import { MSG, PORT_NAME } from "../../src/protocol.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake offscreen host: records what the worker asks for and answers like offscreen.js would. */
function fakeHost({ startReply, running = null } = {}) {
  const h = {
    exists: running != null,
    ensured: 0,
    closed: 0,
    sent: [],
    running,
    startReply: startReply || ((m) => ({ ok: true, engine: m.engine, audioAt: 111 })),
    async ensure() {
      h.ensured += 1;
      h.exists = true;
    },
    async close() {
      h.closed += 1;
      h.exists = false;
    },
    async send(msg) {
      h.sent.push(msg);
      if (msg.type === MSG.OFF_START) return h.startReply(msg);
      if (msg.type === MSG.OFF_STATUS) return h.running || { on: false };
      return { ok: true };
    },
  };
  return { ...h, get: () => h, exists: async () => h.exists };
}

function fakeAction() {
  const a = { badge: "", color: null, title: "" };
  return {
    state: a,
    setBadgeText: async ({ text }) => void (a.badge = text),
    setBadgeBackgroundColor: async ({ color }) => void (a.color = color),
    setBadgeTextColor: async () => {},
    setTitle: async ({ title }) => void (a.title = title),
  };
}

async function setup({ host, sttKey = null, engine = null, lang = null } = {}) {
  const shim = createChromeShim();
  shim.chrome.action = fakeAction();
  const created = [];
  const origCreate = shim.chrome.tabs.create.bind(shim.chrome.tabs);
  shim.chrome.tabs.create = async (o) => {
    created.push(o.url);
    return origCreate(o);
  };
  await shim.addTab({ url: "https://example.com/", elements: [rawEl("e01", { text: "More information" }), rawEl("e02", { text: "메일" })] });
  if (sttKey) await shim.chrome.storage.local.set({ elevenLabsKey: sttKey });
  if (engine) await shim.chrome.storage.local.set({ sttEngine: engine });
  if (lang) await shim.chrome.storage.local.set({ vbLang: lang });
  const h = host || fakeHost();
  const app = await createApp({ chrome: shim.chrome, decideFn: mockDecide(), executeFn: execute, micHost: h });
  shim.chrome.runtime.onConnect.addListener(app.onConnect);
  await sleep(30);
  return { shim, app, host: h.get(), created };
}

test("mic: start runs the recogniser offscreen with the resolved engine, language and page words", async () => {
  const { shim, app, host } = await setup({ sttKey: "sk_test_1234567890" });
  const st = await app.handleMessage({ type: MSG.MIC_START });
  assert.equal(st.on, true);
  assert.equal(st.engine, "elevenlabs");
  assert.equal(st.lang, "ko-KR", "Korean by default");
  assert.equal(st.audioAt, 111);
  assert.equal(host.ensured, 1, "offscreen document created");
  const start = host.sent.find((m) => m.type === MSG.OFF_START);
  assert.equal(start.engine, "elevenlabs");
  assert.equal(start.lang, "ko-KR");
  assert.ok(start.keyterms.includes("메일"), "on-screen labels become keyterms");
  assert.equal(JSON.stringify(host.sent).includes("sk_test"), false, "the ElevenLabs key never goes to the offscreen document");
  assert.equal(shim.chrome.action.state.badge, "ON");
  assert.match(shim.chrome.action.state.title, /listening/);
  assert.equal((await app.handleMessage({ type: MSG.STATE })).mic.on, true);
  // a second start is a no-op
  await app.handleMessage({ type: MSG.MIC_START });
  assert.equal(host.sent.filter((m) => m.type === MSG.OFF_START).length, 1);
});

test("mic: keeps listening after the side panel disconnects; stop closes the offscreen document", async () => {
  const { shim, app, host } = await setup();
  const { client } = shim.connect(PORT_NAME);
  const seen = [];
  client.onMessage.addListener((m) => seen.push(m.type));
  await sleep(20);
  await app.handleMessage({ type: MSG.MIC_START });
  assert.ok(seen.includes(MSG.MIC), "panel told about the mic");
  client.disconnect();
  await sleep(20);
  assert.equal(app.ports.size, 0, "panel gone");
  assert.equal(app.micState().on, true, "mic still on with the panel closed");
  assert.equal(host.closed, 0);
  // transcripts from the offscreen document still reach the controller
  assert.deepEqual(await app.handleMessage({ type: MSG.TRANSCRIPT, text: "scroll down", final: true, utteranceId: "u0-0" }), { ok: true });
  const st = await app.handleMessage({ type: MSG.MIC_STOP });
  assert.equal(st.on, false);
  assert.equal(st.stopReason, "user");
  assert.ok(host.sent.some((m) => m.type === MSG.OFF_STOP));
  assert.equal(host.closed, 1, "offscreen document closed");
  assert.equal(shim.chrome.action.state.badge, "", "badge cleared");
});

test("mic: toggle, Chrome engine without a key, and the speech log survives for a panel opened later", async () => {
  const { app, host } = await setup();
  let st = await app.handleMessage({ type: MSG.MIC_TOGGLE });
  assert.equal(st.on, true);
  assert.equal(st.engine, "chrome", "no ElevenLabs key → Chrome Web Speech");
  await app.handleMessage({ type: MSG.MIC_EVENT, kind: "log", line: "final id=u0-0 “아래로 내려 줘” (chrome)" });
  st = await app.handleMessage({ type: MSG.MIC_TOGGLE });
  assert.equal(st.on, false);
  const hello = await app.handleMessage({ type: MSG.STATE });
  assert.ok(hello.speech.some((e) => e.line.includes("아래로 내려 줘")), "raw speech lines kept in the worker");
  assert.ok(hello.speech.some((e) => /mic on · Chrome Web Speech · ko-KR/.test(e.line)));
  assert.equal(host.sent.filter((m) => m.type === MSG.OFF_START).length, 1);
});

test("mic: permission not granted → error, offscreen closed; the shortcut opens the permission tab", async () => {
  const host = fakeHost({ startReply: () => ({ ok: false, code: "mic_permission", state: "prompt" }) });
  const { app, created } = await setup({ host });
  let st = await app.handleMessage({ type: MSG.MIC_START });
  assert.equal(st.on, false);
  assert.equal(st.error.code, "mic_permission");
  assert.equal(st.error.state, "prompt");
  assert.equal(host.get().closed, 1);
  assert.equal(created.length, 0, "the panel opens the permission tab itself");
  st = await app.micToggle({ fromShortcut: true });
  assert.equal(st.on, false);
  assert.ok(created.some((u) => /permission\.html\?reason=prompt&start=1$/.test(u)), "shortcut path opens permission.html?start=1");
});

test("mic: offscreen events — ElevenLabs falls back to Chrome, idle stop, blocked mic", async () => {
  const { shim, app, host } = await setup({ sttKey: "sk_test_1234567890" });
  await app.handleMessage({ type: MSG.MIC_START });
  await app.handleMessage({ type: MSG.MIC_EVENT, kind: "engine", engine: "chrome", problem: { code: "stt_auth", message: "ElevenLabs rejected the key" } });
  let st = app.micState();
  assert.equal(st.on, true);
  assert.equal(st.engine, "chrome");
  assert.equal(st.notice.code, "stt_auth");
  await app.handleMessage({ type: MSG.MIC_EVENT, kind: "stopped", reason: "idle" });
  st = app.micState();
  assert.equal(st.on, false);
  assert.equal(st.stopReason, "idle");
  assert.equal(host.closed, 1);
  assert.equal(shim.chrome.action.state.badge, "");
  await app.handleMessage({ type: MSG.MIC_START });
  await app.handleMessage({ type: MSG.MIC_EVENT, kind: "stopped", reason: "denied" });
  st = app.micState();
  assert.equal(st.error.code, "mic_permission");
  assert.equal(st.error.state, "denied");
});

test("mic: language switch is stored and restarts a running microphone in the new language", async () => {
  const { shim, app, host } = await setup();
  await app.handleMessage({ type: MSG.MIC_START });
  const st = await app.handleMessage({ type: MSG.SET_LANG, lang: "en-US" });
  assert.equal(st.on, true);
  assert.equal(st.lang, "en-US");
  const starts = host.sent.filter((m) => m.type === MSG.OFF_START);
  assert.deepEqual(
    starts.map((m) => m.lang),
    ["ko-KR", "en-US"],
  );
  assert.equal(shim.chrome.storage.local._dump().vbLang, "en-US");
  assert.equal((await app.handleMessage({ type: MSG.SET_LANG, lang: "fr-FR" })).lang, "en-US", "unknown language ignored");
  // a new worker picks the stored language up
  const again = await setup({ lang: "en-US" });
  assert.equal(again.app.micState().lang, "en-US");
});

test("mic: page changes push fresh ElevenLabs keyterms while listening", async () => {
  const { shim, app, host } = await setup({ sttKey: "sk_test_1234567890" });
  await app.handleMessage({ type: MSG.MIC_START });
  const tab = await shim.addTab({ url: "https://news.example/", elements: [rawEl("e01", { text: "치지직" }), rawEl("e02", { text: "스포츠" })] });
  await shim.chrome.tabs.update(tab.id, { active: true });
  await app.handleMessage({ type: MSG.SNAPSHOT });
  await sleep(20);
  const upd = host.sent.filter((m) => m.type === MSG.OFF_KEYTERMS).at(-1);
  assert.ok(upd, "keyterms update sent");
  assert.ok(upd.keyterms.includes("치지직"));
});

test("mic: a restarted service worker re-adopts a microphone still running offscreen", async () => {
  const host = fakeHost({ running: { on: true, engine: "elevenlabs", lang: "ko-KR", since: 5, audioAt: 6 } });
  const { shim, app } = await setup({ host });
  await sleep(20);
  const st = app.micState();
  assert.equal(st.on, true);
  assert.equal(st.engine, "elevenlabs");
  assert.equal(shim.chrome.action.state.badge, "ON");
  // …and one that is not running any more is cleaned up
  const stale = fakeHost({ running: { on: false } });
  await setup({ host: stale });
  await sleep(20);
  assert.equal(stale.get().closed, 1);
});
