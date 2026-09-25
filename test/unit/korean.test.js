// Local addition (not upstream): Korean transcripts through the code-side span extraction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTextCandidates, extractUrlCandidates, parseCandidatePick } from "../../src/spans.js";
import { detectSite } from "../../src/snapshot.js";

test("ko text candidates: payload before the verb comes first", () => {
  assert.equal(extractTextCandidates("앨런 튜링 검색해 줘")[0], "앨런 튜링");
  assert.equal(extractTextCandidates("검색창에 안녕하세요 입력해 줘")[0], "안녕하세요");
  assert.equal(extractTextCandidates("유튜브에서 로파이 음악 찾아 줘")[0], "로파이 음악");
  assert.equal(extractTextCandidates("안녕이라고 써 줘")[0], "안녕");
  assert.equal(extractTextCandidates("날씨 좀 검색해줘")[0], "날씨");
  assert.equal(extractTextCandidates("인공지능에 대해 검색해 줘")[0], "인공지능");
  assert.equal(extractTextCandidates("이메일 칸에 bob@example.com 입력해 줘")[0], "bob@example.com");
});

test("ko text candidates keep unstripped fallbacks and the whole transcript", () => {
  const c = extractTextCandidates("유튜브에서 로파이 음악 찾아 줘");
  assert.ok(c.includes("유튜브에서 로파이 음악"), "site phrase kept as a fallback span");
  assert.ok(c.includes("유튜브에서 로파이 음악 찾아 줘"), "whole transcript is always a fallback");
  assert.ok(c.length <= 8);
});

test("ko text candidates: no verb -> no Korean payload, English path untouched", () => {
  assert.deepEqual(extractTextCandidates("뒤로 가"), ["가", "뒤로 가"]);
  assert.equal(extractTextCandidates("search for 앨런 튜링")[0], "앨런 튜링");
  assert.equal(extractTextCandidates("type hello world into the search box")[0], "hello world");
});

test("ko spoken URLs: '닷컴' / '닷'", () => {
  assert.deepEqual(extractUrlCandidates("github 닷컴 열어 줘"), ["github.com"]);
  assert.deepEqual(extractUrlCandidates("example 닷 com 으로 가 줘"), ["example.com"]);
  assert.deepEqual(extractUrlCandidates("go to example dot com"), ["example.com"]);
});

test("ko candidate picks", () => {
  assert.equal(parseCandidatePick("2번"), 2);
  assert.equal(parseCandidatePick("두 번째"), 2);
  assert.equal(parseCandidatePick("두번째 거"), 2);
  assert.equal(parseCandidatePick("첫 번째 거 클릭해 줘"), 1);
  assert.equal(parseCandidatePick("둘"), 2);
  assert.equal(parseCandidatePick("세 번째 링크"), 3);
  assert.equal(parseCandidatePick("네"), null, "bare 네 means yes, not four");
  assert.equal(parseCandidatePick("네 번째"), 4);
  assert.equal(parseCandidatePick("다섯 번째", 3), null, "beyond the candidate count");
  assert.equal(parseCandidatePick("두 번째 결과가 좋겠다 그치"), null, "a sentence is not a pick");
  assert.equal(parseCandidatePick("two"), 2);
});

test("naver is a known site", () => {
  assert.equal(detectSite("https://www.naver.com/"), "naver");
  assert.equal(detectSite("https://search.naver.com/search.naver?query=x"), "naver");
  assert.equal(detectSite("https://notnaver.com/"), "generic");
});
