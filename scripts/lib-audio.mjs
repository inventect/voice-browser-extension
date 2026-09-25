/**
 * Shared test-audio helpers for the STT probes (local addition, not upstream).
 * Korean command audio is synthesised with macOS `say` and converted with `afconvert`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Labels a Naver home page snapshot typically exposes (keyterm experiments).
export const NAVER_LIKE = {
  site: "naver",
  url: "https://www.naver.com/",
  elements: ["메일", "카페", "블로그", "쇼핑", "쇼핑라이브", "뉴스", "증권", "부동산", "지도", "웹툰", "치지직", "로그인", "검색", "더보기", "날씨", "스포츠"].map((text, i) => ({ id: `e${i + 1}`, role: "link", text })),
};

export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
}

export function readWavPcm16(file) {
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

export function writeWav(file, pcm, rate = 16000) {
  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/**
 * Synthesise one phrase → Int16Array @ 16 kHz mono.
 * degrade: 8 kHz narrowband + lower level + noise (a pessimistic Bluetooth-headset stand-in).
 */
export function synth(text, { voice = "Yuna", degrade = false, dir, seed = 1234 } = {}) {
  const d = dir || tmpDir("synth-");
  const tag = `${Buffer.from(text).toString("hex").slice(0, 24)}-${degrade ? "d" : "c"}`;
  const aiff = path.join(d, `${tag}.aiff`);
  const wav = path.join(d, `${tag}.wav`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  if (degrade) {
    const nb = path.join(d, `${tag}-8k.wav`);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@8000", "-c", "1", aiff, nb]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", nb, wav]);
  } else {
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  }
  let pcm = readWavPcm16(wav);
  if (degrade) {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    pcm = pcm.map((x) => Math.max(-32768, Math.min(32767, Math.round(x * 0.45 + rnd() * 900))));
  }
  return pcm;
}

/** Korean-aware character error rate (spaces and punctuation ignored). */
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

export const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
