/**
 * Local-server pipeline vs extension pipeline on the SAME live page, same viewport, same Korean
 * commands. Only the snapshot / request / policy code differs, so any gap is the code's, not Jev's.
 *   JVB_DIR=/path/to/jev-voice-browser TYPESAFE_API_KEY=… node scripts/compare-local-vs-ext.mjs [width ...]
 * JVB_DIR defaults to a jev-voice-browser checkout next to this repo.
 * Nothing is clicked: each command is decided on the loaded page and the chosen action printed.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import * as EXT_SNAP from "../src/snapshot.js";
import * as EXT_JEV from "../src/jev.js";
import * as EXT_POL from "../src/policy.js";

const SRV = path.join(process.env.JVB_DIR || fileURLToPath(new URL("../../jev-voice-browser", import.meta.url)), "src");
const imp = (f) => import(pathToFileURL(path.join(SRV, f)).href);
const [SRV_SNAP, SRV_JEV, SRV_POL] = await Promise.all([imp("snapshot.js"), imp("jev.js"), imp("policy.js")]);
const apiKey = process.env.TYPESAFE_API_KEY;

const PIPES = {
  local: { snap: SRV_SNAP, decide: (input) => SRV_JEV.decide(input), pol: SRV_POL },
  ext: { snap: EXT_SNAP, decide: (input) => EXT_JEV.decide(input, { apiKey }), pol: EXT_POL },
};

const PAGES = [
  { url: "https://www.naver.com/", cmds: ["메일 눌러 줘", "카페 눌러 줘", "쇼핑 눌러 줘", "뉴스 눌러 줘", "블로그 눌러 줘", "로그인 눌러 줘", "날씨 검색해 줘", "아래로 스크롤해 줘"] },
  { url: "https://search.naver.com/search.naver?query=" + encodeURIComponent("앨런 튜링"), cmds: ["첫 번째 결과 눌러 줘", "이미지 탭 눌러 줘", "뉴스 탭 눌러 줘", "지식백과 눌러 줘"] },
];
const widths = process.argv.slice(2).map(Number).filter(Boolean);
const VIEWPORTS = (widths.length ? widths : [1280]).map((w) => ({ width: w, height: 720 }));

const flags = (e) => `${e.popup ? " [popup]" : ""}${e.frame ? " [frame]" : ""}${e.inViewport === false ? " [below]" : ""}`;
const short = (s, n = 18) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
let cost = 0;
const tally = { local: { act: 0, total: 0 }, ext: { act: 0, total: 0 } };

const browser = await chromium.launch({ headless: true });
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: vp,
    locale: "ko-KR",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  for (const { url, cmds } of PAGES) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    const title = await page.title();
    const tabs = [{ index: 0, id: 1, title, url: page.url(), active: true }];
    const snaps = {};
    console.log(`\n######## ${vp.width}px  ${page.url().slice(0, 70)}  "${short(title, 30)}"`);
    for (const [name, p] of Object.entries(PIPES)) {
      const data = await page.evaluate(p.snap.collectElementsInPage);
      const s = p.snap.buildSnapshot(data, { tabs, tabId: 1 });
      snaps[name] = s;
      const nPopup = s.elements.filter((e) => e.popup).length, nFrame = s.elements.filter((e) => e.frame).length;
      console.log(`[${name}] elements=${s.elements.length} raw=${data.elements?.length ?? "?"} popup=${s.popup ? `${s.popup.kind} "${short(s.popup.text, 60)}"` : "none"} popupEls=${nPopup} frameEls=${nFrame} searchBox=${s.searchBoxId}`);
      console.log(`   first 14: ` + s.elements.slice(0, 14).map((e) => `${e.id}:${e.role[0]}:"${short(e.text, 12)}"${flags(e)}`).join(" | "));
    }
    for (const transcript of cmds) {
      const row = [];
      for (const [name, p] of Object.entries(PIPES)) {
        const snapshot = snaps[name];
        try {
          const r = await p.decide({ transcript, snapshot, context: null });
          cost += r.costUsd || 0;
          const pol = p.pol.evaluatePolicy({ answers: r.answers, candidates: r.candidates, snapshot, isFinal: true, context: null, transcript });
          const a = pol.action;
          const el = a?.targetId ? snapshot.elements.find((e) => e.id === a.targetId) : null;
          const tgt = r.answers.target;
          const act = a ? `${a.type}${a.targetId ? ` "${short(el?.text, 16)}"${el ? flags(el) : ""}` : ""}${a.query ? ` q="${a.query}"` : ""}${a.via ? ` via ${a.via}` : ""}` : "";
          tally[name].total++;
          if (pol.decision === "act") tally[name].act++;
          row.push(`${name}: ${pol.decision.padEnd(12)} ${act.padEnd(34)} intent=${r.answers.intent?.choice}(${(r.answers.intent?.confidence ?? 0).toFixed(2)}) tgt=${(tgt?.confidence ?? 0).toFixed(2)}`);
        } catch (e) {
          row.push(`${name}: ERROR ${e.name}: ${short(e.message, 80)}`);
        }
      }
      console.log(`  "${transcript}"\n     ${row.join("\n     ")}`);
    }
  }
  await ctx.close();
}
await browser.close();
console.log(`\nacted: local ${tally.local.act}/${tally.local.total}, ext ${tally.ext.act}/${tally.ext.total}   total ≈ $${cost.toFixed(4)}`);
