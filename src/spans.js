/**
 * Candidate extraction (code, not Jev). Jev never generates text: we over-generate
 * candidate spans from the transcript here, and Jev only *picks* one of them.
 * The chosen option is copied verbatim into the browser.
 */

const TLDS = "com|org|net|io|ai|dev|co|edu|gov|de|uk|us|app|xyz|info|me|tv|ch|at|fr|nl|es|it";

const FILLER_RE = /\b(please|thanks|thank you|now|okay|ok|um|uh|and then)\b/gi;

// Verbs that introduce payload text. Order matters: longer/more specific first.
const TEXT_VERBS = [
  /\b(?:search|look)\s+(?:for|up)\s+/i,
  /\bsearch\s+(?:on\s+)?(?:google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|the web)\s+for\s+/i,
  /\bsearch\s+/i,
  /\bgoogle\s+/i,
  /\bfind\s+/i,
  /\btype\s+(?:in\s+)?/i,
  /\benter\s+/i,
  /\bwrite\s+/i,
  /\bput\s+/i,
  /\bfill\s+(?:in\s+)?/i,
];

// Trailing destination phrases to strip from a payload: "... into the search box".
const TRAILING_DEST_RE =
  /\s+(?:in|into|on|inside|to)\s+(?:the\s+)?(?:[\w-]+\s+){0,4}?(?:box|field|input|bar|form|textarea|search|wikipedia|youtube|google|duckduckgo|github|amazon|reddit|twitter|x|web)\b.*$/i;

// Leading site phrases: "wikipedia for cats" -> "cats", "on wikipedia cats" (rare)
const LEADING_SITE_RE =
  /^(?:on\s+|in\s+)?(?:google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|the web)\s+(?:for\s+)?/i;

// --- Korean (local addition, not upstream) ---------------------------------------------------------
// Korean is verb-final, so the payload comes BEFORE the verb: "앨런 튜링 검색해 줘", "검색창에 안녕하세요
// 입력해 줘", "유튜브에서 로파이 음악 찾아 줘", "안녕이라고 써 줘". Same contract as the English path: code
// over-generates candidate spans (stripped and unstripped), Jev picks one, the pick is copied verbatim.
const HANGUL_RE = /[\uac00-\ud7a3]/;
// Greedy prefix => split at the LAST verb ("검색창에 X 입력해 줘" splits at 입력, not inside 검색창).
const KO_VERB_RE = /^(.*\S)\s*(?:검색|찾아|찾기|입력|타이핑|쳐|써|적어)[\uac00-\ud7a3\s]*$/;
// Between payload and verb: 을/를, (이)라고, 좀, 에 대해(서)/관해(서), a trailing "…에서" site or "…창에" field.
const KO_TRAILING_RE = /\s*(?:(?:이)?라고|에\s*(?:대해서?|관해서?)|을|를|좀)$|\s+\S+에서$|\s+\S*(?:창|칸|란|필드|박스)에$/;
// Leading field / site phrases: "검색창에 …", "이메일 칸에 …", "유튜브에서 …".
const KO_LEADING_RE = /^(?:\S+\s+)?\S*(?:창|칸|란|필드|박스)에\s+|^\S+에서\s+/;

function koreanPayloads(t) {
  const s = t.replace(/[.,!?~]+$/g, "").trim();
  if (!HANGUL_RE.test(s)) return [];
  const m = KO_VERB_RE.exec(s);
  if (!m) return [];
  const raw = m[1].trim();
  let core = raw;
  for (let prev = null; prev !== core; ) {
    prev = core;
    core = core.replace(KO_TRAILING_RE, "").trim();
  }
  return [core.replace(KO_LEADING_RE, "").trim(), core, raw.replace(KO_LEADING_RE, "").trim(), raw];
}

export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(s) {
  return s.replace(FILLER_RE, " ").replace(/\s+/g, " ").replace(/[.,!?]+$/g, "").trim();
}

function pushUnique(list, value) {
  const v = stripFiller(value);
  if (!v) return;
  if (v.length > 120) return;
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  list.push(v);
}

/**
 * Candidate text payloads for type/search intents.
 * Returns [] when the transcript is empty. Order: most likely first.
 */
export function extractTextCandidates(transcript) {
  const t = cleanTranscript(transcript);
  if (!t) return [];
  const out = [];

  // 1. quoted spans
  for (const m of t.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) pushUnique(out, m[1]);

  // 1b. Korean: payload before the verb (local addition; no-op without Hangul)
  for (const k of koreanPayloads(t)) pushUnique(out, k);

  // 2. text after a payload verb (earliest verb in the sentence first), destination phrase stripped
  const verbMatches = TEXT_VERBS.map((re) => re.exec(t))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  for (const m of verbMatches) {
    let tail = t.slice(m.index + m[0].length);
    tail = tail.replace(LEADING_SITE_RE, "");
    const stripped = tail.replace(TRAILING_DEST_RE, "");
    pushUnique(out, stripped);
    if (stripped !== tail) pushUnique(out, tail);
  }

  // 3. the tail after the first "for"
  const forIdx = t.toLowerCase().indexOf(" for ");
  if (forIdx >= 0) pushUnique(out, t.slice(forIdx + 5).replace(TRAILING_DEST_RE, ""));

  // 4. tail after the first word (covers "type hello")
  const firstSpace = t.indexOf(" ");
  if (firstSpace > 0) pushUnique(out, t.slice(firstSpace + 1).replace(TRAILING_DEST_RE, ""));

  // 5. whole transcript as a last resort
  pushUnique(out, t);

  return out.slice(0, 8);
}

/** "example dot com" -> "example.com"; also lowercases and strips spaces around dots. */
export function normalizeSpokenUrl(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s*닷\s*컴/g, ".com") // Korean "github 닷컴" (local addition)
    .replace(/\s*닷\s*/g, ".") // Korean "example 닷 org"
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+slash\s+/g, "/")
    .replace(/\bwww\s+/g, "www.")
    .replace(/\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//g, (m) => (m.includes("s") ? "https://" : "http://"));
}

/** Domain-looking spans in the transcript (after spoken-url normalisation). */
export function extractUrlCandidates(transcript) {
  const t = normalizeSpokenUrl(cleanTranscript(transcript));
  if (!t) return [];
  const re = new RegExp(`(?:https?://)?(?:[a-z0-9-]+\\.)+(?:${TLDS})(?:/[^\\s]*)?`, "gi");
  const out = [];
  for (const m of t.matchAll(re)) {
    const v = m[0].replace(/[.,!?]+$/, "");
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 6);
}

export function toHttpUrl(domainish) {
  const v = String(domainish).trim();
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

const NUMBER_WORDS = {
  one: 1, first: 1, "1": 1, "1st": 1,
  two: 2, second: 2, "2": 2, "2nd": 2,
  three: 3, third: 3, "3": 3, "3rd": 3,
  four: 4, fourth: 4, "4": 4, "4th": 4,
  five: 5, fifth: 5, "5": 5, "5th": 5,
};
// Speech-recognizer homophones, only trusted when they are the whole utterance ("to" alone).
const NUMBER_HOMOPHONES = { won: 1, to: 2, too: 2, for: 4 };

/**
 * When numbered candidate overlays are on screen, a bare number ("two", "the second one",
 * "number 3") is a deterministic pick — no need to ask Jev.
 * Returns 1-based index or null.
 */
const PICK_STOPWORDS = new Set([
  "the", "number", "option", "pick", "choose", "select", "click", "take", "that", "please", "link", "item", "result", "go", "with", "on", "yes", "this", "um", "uh",
]);

// Korean picks (local addition): "2번", "두 번째", "첫 번째 거 클릭해 줘", "둘". A bare "네" means "yes",
// so 네/세/한 only count with a counter (번/번째/째); 하나/둘/셋/넷/다섯 also count alone.
const KO_NUM = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 한: 1, 하나: 1, 첫: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5 };
const KO_PICK_RE =
  /^(?:그\s*)?(\d|하나|한|첫|두|둘|세|셋|네|넷|다섯)\s*(번째|번|째)?\s*(?:거|것|꺼|걸로|거요|요|이요|으로|로|링크|결과|항목)?(?:\s*(?:클릭|눌러|선택|열어)[\uac00-\ud7a3\s]*)?$/;
const KO_BARE_OK = new Set(["하나", "둘", "셋", "넷", "다섯"]);

function koreanPick(t, max) {
  const m = KO_PICK_RE.exec(t);
  if (!m) return null;
  if (!m[2] && !KO_BARE_OK.has(m[1])) return null;
  const n = KO_NUM[m[1]];
  return n && n <= max ? n : null;
}

export function parseCandidatePick(transcript, max = 5) {
  const t = cleanTranscript(transcript).toLowerCase().replace(/[.,!?]/g, "");
  if (!t) return null;
  if (HANGUL_RE.test(t)) return koreanPick(t, max);
  const meaningful = t.split(" ").filter((w) => !PICK_STOPWORDS.has(w));
  if (meaningful.length === 0 || meaningful.length > 2) return null;
  for (const w of meaningful) {
    const n = NUMBER_WORDS[w];
    if (n && n <= max) return n;
  }
  if (meaningful.length === 1) {
    const n = NUMBER_HOMOPHONES[meaningful[0]];
    if (n && n <= max) return n;
  }
  return null;
}
