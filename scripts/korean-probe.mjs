/**
 * Korean probe for the extension build: real Jev calls on the project's own page fixtures
 * (incl. pop-up fixtures), same pipeline as the service worker: decide() -> evaluatePolicy().
 * The key comes from the environment and is passed explicitly; nothing secret is printed.
 */
import fs from "node:fs";
import { decide } from "../src/jev.js";
import { evaluatePolicy } from "../src/policy.js";

const apiKey = process.env.TYPESAFE_API_KEY;
const fx = (n) => JSON.parse(fs.readFileSync(new URL(`../test/fixtures/${n}.json`, import.meta.url), "utf8"));
const KO_MODAL = {
  url: "https://shop.example.kr/", title: "예시 쇼핑", site: "generic", searchBoxId: null,
  popup: { kind: "modal", text: "신규 회원 10% 할인 쿠폰 받기 오늘 하루 보지 않기 닫기", count: 1 },
  elements: [
    { id: "e01", role: "button", text: "쿠폰 받기", popup: "modal" },
    { id: "e02", role: "button", text: "오늘 하루 보지 않기", popup: "modal" },
    { id: "e03", role: "button", text: "닫기", popup: "modal" },
    { id: "e04", role: "link", text: "베스트 상품" },
    { id: "e05", role: "link", text: "장바구니" },
  ],
};

const CASES = [
  ["modal-page", "close this", "click e01 (Close)"],
  ["modal-page", "이거 닫아 줘", "click e01 (Close)"],
  ["modal-page", "팝업 꺼 줘", "click e01 (Close)"],
  ["modal-page", "나중에 할게", "click e04/e05 (Not now / Remind me later)"],
  ["banner-page", "쿠키 동의해 줘", "click e01 (Accept all cookies)"],
  ["banner-page", "쿠키 거부해 줘", "click e02 (Reject non-essential)"],
  [KO_MODAL, "팝업 닫아 줘", "click e03 (닫기)"],
  [KO_MODAL, "오늘 하루 보지 않기 눌러 줘", "click e02"],
  [KO_MODAL, "이 탭 닫아 줘", "close_tab (not the pop-up)"],
  ["hn", "카페 눌러 줘", "wait/disambiguate (no 카페 link on HN)"],
];

let cost = 0;
for (const [snapName, transcript, expected] of CASES) {
  const snapshot = typeof snapName === "string" ? fx(snapName) : snapName;
  try {
    const r = await decide({ transcript, snapshot, context: null }, { apiKey });
    const p = evaluatePolicy({ answers: r.answers, candidates: r.candidates, snapshot, isFinal: true, context: null, transcript });
    cost += r.costUsd || 0;
    const a = p.action;
    const el = a?.targetId ? snapshot.elements.find((e) => e.id === a.targetId) : null;
    const act = a ? `${a.type}${a.targetId ? ` ${a.targetId} "${el?.text ?? "?"}"` : ""}${a.via ? ` via ${a.via}` : ""}` : "";
    console.log(`${String(typeof snapName === "string" ? snapName : "ko-modal").padEnd(12)} "${transcript}"`.padEnd(46) + ` ${p.decision.padEnd(12)} ${act.padEnd(44)} intent=${r.answers.intent?.choice}(${(r.answers.intent?.confidence ?? 0).toFixed(2)}) ${r.latencyMs}ms  | expect: ${expected}`);
  } catch (e) {
    console.log(`"${transcript}" ERROR ${e.name}: ${e.message}`);
  }
}
console.log(`\ntotal ≈ $${cost.toFixed(4)}`);
