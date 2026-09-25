// Local addition (not upstream): ElevenLabs Scribe v2 Realtime helpers + worker messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScribeUrl, buildKeyterms, cleanTerm, mintScribeToken, sameKeyterms, scribeLanguage, scribeMessageToTranscript, MAX_KEYTERMS, SCRIBE_TOKEN_URL } from "../../src/scribe-util.js";
import { createChromeShim, rawEl } from "../helpers/chrome-shim.js";
import { createApp, resolveEngine } from "../../src/app.js";
import { execute } from "../../src/executor.js";
import { mockDecide } from "../helpers/mock-jev.js";
import { MSG } from "../../src/protocol.js";

test("scribe: language codes and WebSocket URL", () => {
  assert.equal(scribeLanguage("ko-KR"), "ko");
  assert.equal(scribeLanguage("en-US"), "en");
  const u = new URL(buildScribeUrl({ token: "tok123", languageCode: "ko-KR", keyterms: ["메일", "쇼핑라이브"], vadSilenceSecs: 0.8 }));
  assert.equal(u.origin + u.pathname, "wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  assert.equal(u.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(u.searchParams.get("token"), "tok123");
  assert.equal(u.searchParams.get("audio_format"), "pcm_16000");
  assert.equal(u.searchParams.get("language_code"), "ko");
  assert.equal(u.searchParams.get("commit_strategy"), "vad");
  assert.equal(u.searchParams.get("vad_silence_threshold_secs"), "0.8");
  assert.deepEqual(u.searchParams.getAll("keyterms"), ["메일", "쇼핑라이브"]);
  const many = new URL(buildScribeUrl({ token: "t", keyterms: Array.from({ length: 80 }, (_, i) => `단어${i}`) }));
  assert.equal(many.searchParams.getAll("keyterms").length, MAX_KEYTERMS);
});

test("scribe: keyterms come from on-screen labels (pop-up first), cleaned, capped, site names appended", () => {
  assert.equal(cleanTerm("  메일  "), "메일");
  assert.equal(cleanTerm("→ 쇼핑라이브 ▶"), "쇼핑라이브");
  assert.equal(cleanTerm("2026.09.25"), "", "numbers/dates are not commands");
  assert.equal(cleanTerm("오늘의 주요 뉴스 헤드라인을 한눈에 확인하세요"), "", "long headlines dropped");
  assert.equal(cleanTerm("x"), "");
  const snap = {
    elements: [
      { text: "메일" },
      { text: "카페" },
      { text: "메일" }, // duplicate
      { text: "오늘의 주요 뉴스 헤드라인을 한눈에 확인하세요" },
      { text: "더보기", below_fold: true },
      { text: "닫기", popup: true },
      { placeholder: "검색어를 입력해 주세요" },
    ],
  };
  const k = buildKeyterms(snap, "ko-KR");
  assert.equal(k[0], "닫기", "pop-up controls first");
  assert.deepEqual(k.slice(1, 5), ["메일", "카페", "검색어를 입력해 주세요", "더보기"]);
  assert.ok(k.includes("네이버") && k.includes("유튜브"), "site names appended");
  assert.equal(new Set(k.map((x) => x.toLowerCase())).size, k.length, "unique");
  const big = { elements: Array.from({ length: 200 }, (_, i) => ({ text: `메뉴${i}` })) };
  const kb = buildKeyterms(big, "ko");
  assert.equal(kb.length, MAX_KEYTERMS);
  assert.ok(kb.includes("네이버"), "site names survive a crowded page");
  assert.ok(buildKeyterms(null, "en").includes("Wikipedia"));
  assert.equal(sameKeyterms(["a", "B"], ["b", "A"]), true);
  assert.equal(sameKeyterms(["a"], ["a", "b"]), false);
});

test("scribe: server messages map to transcript messages (partial → interim, committed → final)", () => {
  assert.deepEqual(scribeMessageToTranscript({ message_type: "partial_transcript", text: " 메일 " }, { session: 2, segment: 0 }), { text: "메일", final: false, utteranceId: "el2-0" });
  assert.deepEqual(scribeMessageToTranscript({ message_type: "committed_transcript", text: "메일 눌러줘." }, { session: 2, segment: 0 }), { text: "메일 눌러줘.", final: true, utteranceId: "el2-0" });
  assert.equal(scribeMessageToTranscript({ message_type: "partial_transcript", text: "" }), null);
  assert.equal(scribeMessageToTranscript({ message_type: "session_started" }), null);
  assert.equal(scribeMessageToTranscript(null), null);
});

test("scribe: token minting sends the key only as xi-api-key and never echoes it", async () => {
  const seen = [];
  const ok = await mintScribeToken({
    apiKey: "sk_secret_value",
    fetchFn: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ token: "single-use-abc" }), { status: 200 });
    },
  });
  assert.deepEqual(ok, { ok: true, token: "single-use-abc" });
  assert.equal(seen[0].url, SCRIBE_TOKEN_URL);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["xi-api-key"], "sk_secret_value");
  const bad = await mintScribeToken({
    apiKey: "sk_secret_value",
    fetchFn: async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key: sk_secret_value" } }), { status: 401 }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "stt_key_rejected");
  assert.equal(bad.error.includes("sk_secret_value"), false, "key never echoed");
  assert.equal((await mintScribeToken({ apiKey: "" })).code, "no_stt_key");
  const net = await mintScribeToken({ apiKey: "k", fetchFn: async () => Promise.reject(new TypeError("Failed to fetch")) });
  assert.equal(net.code, "stt_network");
});

test("app: STT key/engine stored in chrome.storage.local only; tokens minted in the worker", async () => {
  assert.equal(resolveEngine("auto", true), "elevenlabs");
  assert.equal(resolveEngine("auto", false), "chrome");
  assert.equal(resolveEngine("chrome", true), "chrome");
  assert.equal(resolveEngine("elevenlabs", false), "elevenlabs");

  const shim = createChromeShim();
  await shim.addTab({ url: "https://example.com/", elements: [rawEl("e01", { text: "More information" })] });
  const calls = [];
  const app = await createApp({
    chrome: shim.chrome,
    decideFn: mockDecide(),
    executeFn: execute,
    sttFetch: async (url, init) => {
      calls.push({ url, key: init.headers["xi-api-key"] });
      return new Response(JSON.stringify({ token: `tok-${calls.length}` }), { status: 200 });
    },
  });
  let st = await app.handleMessage({ type: MSG.STT_STATUS });
  assert.deepEqual(st, { hasKey: false, masked: "", engine: "auto", resolved: "chrome" });
  assert.equal((await app.handleMessage({ type: MSG.STT_TOKEN })).code, "no_stt_key");
  assert.equal(calls.length, 0, "no network call without a key");

  st = await app.handleMessage({ type: MSG.SET_STT, apiKey: "  sk_1234567890abcdef  " });
  assert.equal(st.hasKey, true);
  assert.equal(st.resolved, "elevenlabs");
  assert.equal(st.masked, "sk_…cdef");
  assert.equal(shim.chrome.storage.local._dump().elevenLabsKey, "sk_1234567890abcdef");
  assert.equal(JSON.stringify(shim.chrome.storage.session._dump()).includes("sk_123"), false, "key never in session state");

  const tok = await app.handleMessage({ type: MSG.STT_TOKEN });
  assert.deepEqual(tok, { ok: true, token: "tok-1" });
  assert.equal(calls[0].key, "sk_1234567890abcdef");
  const t = await app.handleMessage({ type: MSG.TEST_STT });
  assert.equal(t.ok, true);
  assert.equal(typeof t.latencyMs, "number");
  assert.equal("token" in t, false, "test result does not leak a token");

  st = await app.handleMessage({ type: MSG.SET_STT, engine: "chrome" });
  assert.equal(st.resolved, "chrome");
  st = await app.handleMessage({ type: MSG.SET_STT, engine: "bogus" });
  assert.equal(st.engine, "chrome", "unknown engine ignored");
  st = await app.handleMessage({ type: MSG.SET_STT, apiKey: "" });
  assert.equal(st.hasKey, false);
  assert.equal("elevenLabsKey" in shim.chrome.storage.local._dump(), false);
  // the Jev key is untouched by all of this
  assert.equal("apiKey" in shim.chrome.storage.local._dump(), false);
});
