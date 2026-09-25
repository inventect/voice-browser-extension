#!/usr/bin/env node
/**
 * ElevenLabs Scribe v2 Realtime probe (local addition, not upstream).
 * Korean command audio is synthesised with macOS `say` (voice Yuna), streamed in real time to
 * wss://api.elevenlabs.io/v1/speech-to-text/realtime exactly like the side panel will, and the
 * partial / committed transcripts are timed against the end of each phrase.
 *
 *   ELEVENLABS_API_KEY=… node scripts/el-probe.mjs [--degrade] [--keyterms] [--vad 0.8] [--only 1,2]
 *
 * --degrade : 8 kHz narrowband + noise + lower level (roughly a Bluetooth headset mic)
 * --keyterms: bias toward a Naver-like list of on-page labels
 * The key is read from the environment and never printed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScribeUrl, buildKeyterms } from "../src/scribe-util.js";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const KEY = process.env.ELEVENLABS_API_KEY || "";
if (!KEY) {
  console.error("Missing ELEVENLABS_API_KEY");
  process.exit(1);
}
const DEGRADE = args.includes("--degrade");
const USE_KEYTERMS = args.includes("--keyterms");
const VAD = Number(flag("--vad", 0.8));
const VOICE = flag("--voice", "Yuna");
const ONLY = flag("--only", null) ? String(flag("--only")).split(",").map(Number) : null;

export const PHRASES = [
  "네이버 열어 줘",
  "메일 눌러 줘",
  "쇼핑 라이브 클릭해 줘",
  "조금 아래로 스크롤해 줘",
  "앨런 튜링 검색해 줘",
  "뒤로 가",
  "이 팝업 닫아 줘",
  "카페 들어가 줘",
  "유튜브에서 아이유 노래 검색해 줘",
  "두 번째 거 눌러 줘",
  "새 탭 열어 줘",
  "치지직 눌러 줘",
];
// Labels a Naver home page snapshot typically exposes (used only with --keyterms).
const NAVER_LIKE = {
  site: "naver",
  url: "https://www.naver.com/",
  elements: ["메일", "카페", "블로그", "쇼핑", "쇼핑라이브", "뉴스", "증권", "부동산", "지도", "웹툰", "치지직", "로그인", "검색", "더보기", "날씨", "스포츠"].map((text, i) => ({ id: `e${i + 1}`, role: "link", text })),
};

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "el-probe-"));
function synth(text, i) {
  const aiff = path.join(tmp, `p${i}.aiff`);
  const wav = path.join(tmp, `p${i}.wav`);
  execFileSync("say", ["-v", VOICE, "-o", aiff, text]);
  if (DEGRADE) {
    const nb = path.join(tmp, `p${i}-8k.wav`);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@8000", "-c", "1", aiff, nb]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", nb, wav]);
  } else {
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  }
  let pcm = readWavPcm16(wav);
  if (DEGRADE) {
    let seed = 1234 + i;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    pcm = pcm.map((s) => Math.max(-32768, Math.min(32767, Math.round(s * 0.45 + rnd() * 900))));
  }
  return pcm;
}
function readWavPcm16(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") return Int16Array.from({ length: size / 2 }, (_, k) => b.readInt16LE(off + 8 + k * 2));
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

async function mintToken() {
  const t0 = Date.now();
  const res = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", { method: "POST", headers: { "xi-api-key": KEY } });
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { token } = await res.json();
  return { token, ms: Date.now() - t0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString("base64");
const CHUNK = 1600; // 100 ms @ 16 kHz

/** Korean-aware character error rate (spaces ignored). */
export function cer(ref, hyp) {
  const norm = (s) => String(s).replace(/[\s.,!?·"'“”]/g, "").toLowerCase();
  const a = [...norm(ref)];
  const b = [...norm(hyp)];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return a.length ? d[a.length][b.length] / a.length : 0;
}

async function main() {
  const list = PHRASES.map((p, i) => ({ i: i + 1, text: p })).filter((p) => !ONLY || ONLY.includes(p.i));
  const audio = list.map((p) => ({ ...p, pcm: synth(p.text, p.i) }));
  const keyterms = USE_KEYTERMS ? buildKeyterms(NAVER_LIKE, "ko") : [];
  const { token, ms: tokenMs } = await mintToken();
  const url = buildScribeUrl({ token, languageCode: "ko", keyterms, vadSilenceSecs: VAD });
  const t0 = Date.now();
  const ws = new WebSocket(url);
  const events = [];
  let started = null;
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    events.push({ t: Date.now(), ...d });
    if (d.message_type === "session_started") started = Date.now();
    else if (!/transcript/.test(d.message_type)) console.log("  server:", d.message_type, (d.error || d.message || "").slice?.(0, 160) || "");
  };
  ws.onerror = (e) => console.log("  ws error:", e.message || e.type);
  await new Promise((res, rej) => {
    ws.onopen = res;
    setTimeout(() => rej(new Error("ws open timeout")), 8000);
  });
  const openMs = Date.now() - t0;
  for (let k = 0; k < 50 && !started; k++) await sleep(50);
  console.log(`token ${tokenMs} ms · ws open ${openMs} ms · session_started ${started ? started - t0 : "–"} ms · vad ${VAD}s · keyterms ${keyterms.length} · ${DEGRADE ? "DEGRADED audio" : "clean audio"} · voice ${VOICE}`);

  const results = [];
  const silence = new Int16Array(CHUNK);
  for (const p of audio) {
    const from = events.length;
    const tStart = Date.now();
    for (let off = 0; off < p.pcm.length; off += CHUNK) {
      const chunk = p.pcm.subarray(off, Math.min(p.pcm.length, off + CHUNK));
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(chunk), commit: false, sample_rate: 16000 }));
      await sleep(100);
    }
    const speechEnd = Date.now();
    // trailing silence so VAD can commit
    let committed = null;
    for (let k = 0; k < 40 && !committed; k++) {
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(silence), commit: false, sample_rate: 16000 }));
      await sleep(100);
      committed = events.slice(from).find((e) => e.message_type === "committed_transcript" && e.text?.trim());
    }
    for (let k = 0; k < 6; k++) {
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(silence), commit: false, sample_rate: 16000 }));
      await sleep(100);
    }
    const mine = events.slice(from);
    const partials = mine.filter((e) => e.message_type === "partial_transcript" && e.text?.trim());
    const firstPartial = partials[0];
    const fullPartial = partials.find((e) => cer(p.text, e.text) === 0);
    const r = {
      i: p.i,
      ref: p.text,
      hyp: committed?.text?.trim() ?? "(none)",
      cer: committed ? cer(p.text, committed.text) : 1,
      firstPartialMs: firstPartial ? firstPartial.t - tStart : null,
      fullPartialAfterEndMs: fullPartial ? fullPartial.t - speechEnd : null,
      commitAfterEndMs: committed ? committed.t - speechEnd : null,
      partials: partials.map((e) => e.text.trim()),
      speechMs: speechEnd - tStart,
    };
    results.push(r);
    console.log(
      `${String(p.i).padStart(2)} ${r.cer === 0 ? "✓" : "✗"} “${r.hyp}”${r.cer ? `  (ref “${r.ref}”, CER ${(r.cer * 100).toFixed(0)}%)` : ""}\n     speech ${r.speechMs} ms · 1st partial +${r.firstPartialMs ?? "–"} ms · exact partial ${r.fullPartialAfterEndMs == null ? "–" : `${r.fullPartialAfterEndMs >= 0 ? "+" : ""}${r.fullPartialAfterEndMs} ms vs end`} · commit +${r.commitAfterEndMs ?? "–"} ms · partials: ${r.partials.slice(0, 6).map((s) => `“${s}”`).join(" → ")}${r.partials.length > 6 ? " …" : ""}`,
    );
  }
  ws.close();
  const ok = results.filter((r) => r.cer === 0).length;
  const meanCer = results.reduce((s, r) => s + r.cer, 0) / results.length;
  const med = (xs) => {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  console.log(
    `\nSUMMARY exact ${ok}/${results.length} · mean CER ${(meanCer * 100).toFixed(1)}% · median exact-partial vs speech end ${med(results.map((r) => r.fullPartialAfterEndMs))} ms · median commit after end ${med(results.map((r) => r.commitAfterEndMs))} ms`,
  );
  const out = flag("--out", null);
  if (out) fs.writeFileSync(out, JSON.stringify({ degrade: DEGRADE, keyterms, vad: VAD, voice: VOICE, results }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
