/**
 * Keyword-driven mock of jev.decide for controller / app tests (same shape the real one returns).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mockDecide({ latency = 20, complete = (t) => (t.split(" ").length >= 2 ? 0.9 : 0.1) } = {}) {
  const calls = [];
  const fn = async (input, { signal } = {}) => {
    const { transcript, snapshot, context } = input;
    calls.push({ transcript, snapshot, context });
    await sleep(latency);
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const t = transcript.toLowerCase().replace(/^(and then|and|then)\s+/, ""); // the tail of a chained breath
    const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
    let intent = ch("none", 0.9);
    let target = ch("none", 0.9);
    let site = ch("none");
    let text_span;
    let url_span;
    let is_correction = { noul: 0.02 };
    const els = snapshot?.elements || [];
    const byText = (re) => els.find((e) => re.test(e.text || ""));

    {
      if (t.startsWith("go back")) intent = ch("go_back");
      else if (t === "go to") intent = ch("navigate_url", 0.9); // verb without a destination → policy waits ("where to?")
      else if (t.startsWith("go to wikipedia")) {
        intent = ch("navigate_url");
        site = ch("wikipedia", 0.95);
      } else if (t.startsWith("go to example dot com") || t.startsWith("open example dot com")) {
        intent = ch("navigate_url");
        url_span = ch("example.com", 0.9);
      } else if (t.startsWith("search for ")) {
        intent = ch("search_web");
        text_span = ch(t.replace("search for ", ""), 0.9);
      } else if (t.startsWith("scroll")) intent = ch(t.includes("up") ? "scroll_up" : "scroll_down");
      else if (t.startsWith("open a new tab")) intent = ch("open_new_tab");
      else if (t.startsWith("close this tab")) intent = ch("close_tab");
      else if (t.startsWith("next tab")) intent = ch("switch_tab");
      else if (t.startsWith("no not that one")) {
        intent = ch("none", 0.4, { go_back: 0.3 });
        is_correction = { noul: 0.92 };
      } else if (t.startsWith("click ambiguous")) {
        intent = ch("click_element");
        target = ch(els[0]?.id ?? "e01", 0.2, { [els[1]?.id ?? "e02"]: 0.4, none: 0.2 });
      } else if (t.startsWith("click ")) {
        intent = ch("click_element");
        const word = t.replace("click ", "").replace(/^the /, "").split(" ")[0];
        const el = byText(new RegExp(word, "i")) || els[0];
        target = el ? ch(el.id, 0.95) : ch("none", 0.9);
      }
    }
    const answers = {
      intent,
      target,
      site,
      complete: { noul: complete(t) },
      is_command: { noul: intent.choice === "none" && is_correction.noul < 0.5 ? 0.1 : 0.95 },
      destructive: { noul: 0.02 },
      scroll_amount: { score: t.includes("bottom") ? 2 : t.includes("bit") ? 0 : 1, confidence: 0.9, probabilities: {} },
      tab_direction: ch("none"),
    };
    if (text_span) answers.text_span = text_span;
    if (url_span) answers.url_span = url_span;
    if (context?.recentActions?.length) answers.is_correction = is_correction;
    return {
      answers,
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: text_span ? [text_span.choice] : [], url: url_span ? [url_span.choice] : [] },
      state: {},
      questionCount: 8,
    };
  };
  fn.calls = calls;
  return fn;
}
