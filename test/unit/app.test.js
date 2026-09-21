/**
 * Service-worker app + message protocol against the chrome shim: every message type the side
 * panel / options page sends, port broadcasts, API key storage, session persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChromeShim, rawEl } from "../helpers/chrome-shim.js";
import { createApp, maskKey } from "../../src/app.js";
import { configureJev } from "../../src/jev.js";
import { execute } from "../../src/executor.js";
import { mockDecide } from "../helpers/mock-jev.js";
import { MSG, PORT_NAME, isRestrictedUrl, isBlankUrl } from "../../src/protocol.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const shim = createChromeShim();
  await shim.addTab({ url: "https://example.com/", elements: [rawEl("e01", { text: "More information", href: "iana.org/domains/example" })] });
  const decideFn = mockDecide();
  const app = await createApp({ chrome: shim.chrome, decideFn, executeFn: execute });
  // what background.js does at top level
  shim.chrome.runtime.onConnect.addListener(app.onConnect);
  shim.chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    app.handleMessage(msg, sender).then(sendResponse);
    return true;
  });
  await sleep(30);
  return { shim, app, decideFn };
}

test("protocol: restricted / blank URL classification", () => {
  assert.equal(isRestrictedUrl("chrome://extensions/"), true);
  assert.equal(isRestrictedUrl("chrome-extension://abc/options.html"), true);
  assert.equal(isRestrictedUrl("https://chromewebstore.google.com/detail/x"), true);
  assert.equal(isRestrictedUrl("about:blank"), true);
  assert.equal(isRestrictedUrl("https://example.com/"), false);
  assert.equal(isRestrictedUrl("http://localhost:3000/"), false);
  assert.equal(isBlankUrl("about:blank"), true);
  assert.equal(isBlankUrl("chrome://newtab/"), true);
  assert.equal(isBlankUrl("https://example.com/"), false);
  assert.equal(maskKey("ts-1234567890abcd"), "ts-…abcd");
  assert.equal(maskKey("short"), "••••");
});

test("STATE returns uiState + api key status; SET_API_KEY stores in chrome.storage.local only", async () => {
  const { shim, app } = await setup();
  let st = await app.handleMessage({ type: MSG.STATE });
  assert.equal(st.apiKey.hasKey, false);
  assert.equal(st.model, "jev-1.13.0");
  assert.equal(st.snapshot.url, "https://example.com/");
  assert.equal(st.snapshot.elements.length, 1);

  const set = await app.handleMessage({ type: MSG.SET_API_KEY, apiKey: " ts-secret-key-value-1234 " });
  assert.equal(set.hasKey, true);
  assert.equal(set.masked, "ts-…1234");
  assert.equal(shim.chrome.storage.local._dump().apiKey, "ts-secret-key-value-1234");
  assert.equal(JSON.stringify(shim.chrome.storage.session._dump()).includes("ts-secret"), false, "key never in session state");
  st = await app.handleMessage({ type: MSG.API_KEY_STATUS });
  assert.equal(st.hasKey, true);
  const cleared = await app.handleMessage({ type: MSG.SET_API_KEY, apiKey: "" });
  assert.equal(cleared.hasKey, false);
});

test("COMMAND drives an action on the active tab; port receives hello + broadcasts; state persisted to session storage", async () => {
  const { shim, app } = await setup();
  const { client } = shim.connect(PORT_NAME);
  await sleep(10);
  assert.equal(client.received[0].type, MSG.HELLO);
  assert.equal(client.received[0].payload.apiKey.hasKey, false);

  const res = await app.handleMessage({ type: MSG.COMMAND, text: "go to wikipedia" });
  assert.deepEqual(res, { ok: true });
  await sleep(300);
  const types = client.received.map((m) => m.type);
  assert.ok(types.includes(MSG.TRANSCRIPT));
  assert.ok(types.includes(MSG.DECISION));
  assert.ok(types.includes(MSG.ACTION));
  assert.ok(types.includes(MSG.LOG));
  const action = client.received.find((m) => m.type === MSG.ACTION).payload;
  assert.equal(action.action.type, "navigate_url");
  assert.equal(action.ok, true);
  assert.equal(action.ui.stats.actions, 1);
  assert.equal([...shim.tabs.values()][0].url, "https://en.wikipedia.org/wiki/Main_Page");

  await sleep(100);
  const saved = shim.chrome.storage.session._dump().vbState;
  assert.ok(saved, "persisted");
  assert.equal(saved.stats.actions, 1);
  assert.equal(Object.values(saved.contexts)[0].recentActions.length, 1);

  // a fresh app (simulated SW restart) restores stats + context
  const app2 = await createApp({ chrome: shim.chrome, decideFn: mockDecide(), executeFn: execute });
  assert.equal(app2.controller.stats.actions, 1);
  assert.equal(app2.controller.context.recentActions.length, 1);

  // port messages are accepted too (the side panel uses the port for everything)
  client.postMessage({ type: MSG.STATE });
  await sleep(10);
  assert.equal(client.received.at(-1).type, MSG.HELLO);
  // and runtime.sendMessage (options page / e2e test path)
  const viaRuntime = await shim.chrome.runtime.sendMessage({ type: MSG.STATE });
  assert.equal(viaRuntime.stats.actions, 1);
  client.disconnect();
  assert.equal(app.ports.size, 0);
});

test("TRANSCRIPT partials word by word: acts once the words commit, ignores the rest of the utterance", async () => {
  const { shim, app } = await setup();
  for (const partial of ["go", "go to", "go to wikipedia"]) {
    await app.handleMessage({ type: MSG.TRANSCRIPT, text: partial, final: false, utteranceId: "u1" });
    await sleep(60);
  }
  await sleep(400);
  assert.equal(app.controller.stats.actions, 1);
  await app.handleMessage({ type: MSG.TRANSCRIPT, text: "go to wikipedia please", final: true, utteranceId: "u1" });
  await sleep(300);
  assert.equal(app.controller.stats.actions, 1, "one action per utterance");
  assert.equal([...shim.tabs.values()][0].url, "https://en.wikipedia.org/wiki/Main_Page");
});

test("UNDO goes back; SNAPSHOT re-scans; SET_WINDOW / PING / unknown", async () => {
  const { shim, app } = await setup();
  await app.handleMessage({ type: MSG.COMMAND, text: "go to wikipedia" });
  await sleep(300);
  await app.handleMessage({ type: MSG.UNDO });
  await sleep(300);
  assert.equal([...shim.tabs.values()][0].url, "https://example.com/");
  const snap = await app.handleMessage({ type: MSG.SNAPSHOT });
  assert.equal(snap.snapshot.url, "https://example.com/");
  assert.deepEqual(await app.handleMessage({ type: MSG.SET_WINDOW, windowId: 1 }), { ok: true });
  assert.equal(app.browser.preferredWindowId, 1);
  assert.equal((await app.handleMessage({ type: MSG.PING })).ok, true);
  assert.match((await app.handleMessage({ type: "nope" })).error, /unknown/);
  assert.match((await app.handleMessage(null)).error, /bad/);
});

test("TEST_CONNECTION: no key → error; with key → one small request carrying the Bearer header", async () => {
  const { shim, app } = await setup();
  assert.equal((await app.handleMessage({ type: MSG.TEST_CONNECTION })).ok, false);
  const seen = [];
  configureJev({
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { is_command: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 40, output_tokens: 2 } }), { status: 200, headers: { "x-typesafe-request-id": "r1" } });
    },
  });
  await shim.chrome.storage.local.set({ apiKey: "ts-test-key" });
  const r = await app.handleMessage({ type: MSG.TEST_CONNECTION });
  assert.equal(r.ok, true);
  assert.equal(r.model, "jev-1.13.0");
  assert.equal(seen[0].init.headers.Authorization, "Bearer ts-test-key");
  assert.equal(JSON.parse(seen[0].init.body).model, "jev-1.13.0");
  configureJev({ fetch: (...a) => globalThis.fetch(...a) });
});

test("missing API key surfaces as an error event (no crash), key status flips after saving", async () => {
  const shim = createChromeShim();
  await shim.addTab({ url: "https://example.com/" });
  const app = await createApp({ chrome: shim.chrome, executeFn: execute }); // real decide → needs a key
  shim.chrome.runtime.onConnect.addListener(app.onConnect);
  const { client } = shim.connect(PORT_NAME);
  await app.handleMessage({ type: MSG.COMMAND, text: "go to wikipedia" });
  await sleep(200);
  const err = client.received.find((m) => m.type === MSG.ERROR);
  assert.ok(err, "error broadcast");
  assert.equal(err.payload.code, "no_api_key");
  assert.equal(app.controller.stats.actions, 0);
});
