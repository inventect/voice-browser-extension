# DEMO.md — "I talk to my own Chrome, and it acts before I finish the sentence"

Target length 3–5 minutes. One window: your normal Chrome with the **side panel** open on the
right (the extension) and the page on the left. Speak short, natural commands; pause ~1 s between
them.

## Before recording

```bash
cd voice-browser-extension
npm install && npm run build
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`. Options → paste the
   TypeSafe key → **Test connection** (`✓ jev-1.13.0 answered in ~300 ms`).
2. Open `https://example.com`, click the toolbar icon → side panel. Press **Start mic**; a tab asks
   for the microphone once → **Allow**; it closes itself and the red dot starts pulsing.
3. Say "scroll down" once to warm up the API connection (first call ~700 ms, later ones ~300 ms).
4. Optional dry run without talking: `npm run test:e2e:headed` replays the whole script below in
   a throw-away Chromium profile.

If the room is noisy the `is_command` gate ignores side talk anyway — that is a demo point.

---

## 0:00 — Hook (15 s)

> **"Go to wikipedia."**

The tab navigates as the word "wikipedia" lands. Point at the side panel header: **last ~300 ms**,
**cost $0.000xxx**.

Line: *"That wasn't an LLM writing a plan. A model answered eleven yes/no and multiple-choice
questions in three hundred milliseconds, and code did the rest — inside a normal Chrome extension."*

## 0:20 — What Jev is (30 s)

Point at **JEV DECISION** and the intent bars.

- Jev is TypeSafe's *System One* model: it does not generate text. You send a state and typed
  questions, you get one typed answer per question — probabilities, not prose.
- All questions are answered **in parallel**, so we ask everything speculatively in one request:
  intent, which element, which site, "is the sentence finished?", "is this even for me?", "is it
  destructive?", scroll amount, which verbatim span is the search text, "is this a correction?".
- $0.042 per million input tokens, output free. The cost pill: a whole demo is about a cent.

## 0:50 — Acting on partial speech (45 s)

Say slowly, with a small pause after "for":

> **"Search for … Alan Turing."**

While you pause the gate table shows `complete 0.03 ✗` — it *waits*. Then it types into
Wikipedia's own search box and presses Enter (orange highlight + toast in the page).

Line: *"`complete` is why it can act early without acting wrong. And the text it typed was never
generated — code cut candidate spans out of the transcript, Jev only picked one. See text_span."*

> **"Scroll down a bit."** · **"Scroll to the bottom."**

Point at **SCROLL AMOUNT**: a 3-level Score — a little / one page / to the end.

> **"Go back."**

## 1:35 — Clicking things: the element snapshot (45 s)

> **"Go to hacker news."**

Open **CONTROLLED PAGE → elements sent to Jev**: ~100 interactive elements with short ids, viewport
first, 60 chars each. That is the whole state — a few thousand tokens — collected by the content
script on the page you are looking at.

> **"Click the new link."**

The target bar shows `e03 new 0.97`; the element flashes orange before the click.

> **"Click on a link."**

Ambiguous → numbered blue badges appear on the candidates in the page, toast *"Which one? Say the
number."* Say:

> **"Two."**

Line: *"No model call for the number — that's a regex. Jev answers judgment, code answers
arithmetic."*

## 2:20 — Corrections and context (30 s)

> **"Go to example dot com."** · **"Click the more information link."**

Then, as if annoyed:

> **"No, not that one."**

The gate table shows `is_correction 0.9 ✓ — rejects previous action: click link "Learn more"` and
the tab goes back. Point at the *context* Jev received: the previous page and the last three
actions with their outcomes ("navigated to iana.org/…"). *"Jev has no memory between requests; the
memory lives in the state — per tab."*

## 2:50 — Safety gates (30 s)

Side-talk to someone off camera in a normal voice:

> **"…so anyway I think we should get lunch after this."**

Verdict: `IGNORE — not a browser command`, `is_command 0.02`. Nothing moved.

Destructive gate (optional, needs a page with a buy/submit/delete button): "click place order" →
verdict `CONFIRM`, toast *Say "confirm"…* → say "cancel".

## 3:20 — Two commands in one breath, tabs (20 s)

> **"Open a new tab and go to wikipedia."**

The tab opens as soon as "open a new tab" is complete; the remaining words become a second command.

> **"Close this tab."**

Switch to another tab by hand and say "scroll down": the side panel follows the active tab.

## 3:40 — Show the code (40 s)

Open `src/constants.js`:

- `MODEL = "jev-1.13.0"` — pinned; aliases move and thresholds are tuned per version.
- `INTENT_CRITERIA`: every option is `{what, not_for, examples}` — contrastive descriptions make a
  Choice sharp.
- `T` — the thresholds in the gate table. *"This is the entire policy. Change a number, not a prompt."*

Open `src/policy.js` briefly: `if` statements over probabilities. Then `manifest.json`: side panel,
service worker, content script, and why `<all_urls>` (voice control has to work wherever you are).

## 4:20 — Numbers and close (20 s)

```bash
npm run test:integration    # 34/34 real-API cases, latency avg ≈ 340 ms
npm run test:e2e            # 17 spoken commands in headless Chromium, asserts URLs / scroll / tabs
```

Read the summary line: *acted@word < total* means the browser acted before the sentence ended.

Close: *"Fast because it's not thinking out loud. Reliable because code owns the control flow and
the model only answers the questions a person could answer in a second. And it's your browser —
your tabs, your logins, your side panel."*

---

## Phrases that work well (backup list)

- "go to youtube" · "open github" · "go to news dot ycombinator dot com"
- "search wikipedia for alan turing" · "search youtube for lofi beats" · "look up the weather in berlin"
- "click the first result" · "click sign in" · "open the comments tab"
- "type hello world into the search box" · "press enter"
- "scroll down a page" · "scroll up" · "back to the top"
- "reload" · "go forward" · "next tab" · "undo that"

## If something goes wrong on camera

- Mic stops after silence: Chrome ends continuous sessions after ~60 s; the panel restarts it (the
  dot keeps pulsing). `error: not-allowed` → the permission tab opens again; Allow it.
- Nothing happens: read the gate table — it names the failing threshold. Say it more explicitly
  ("click the link that says new"). Check the key pill in the header is green.
- "can't control this page": you are on a `chrome://` page, the Web Store or a PDF — say
  "go to …" to leave it.
- Wrong element: say "no, not that one" or "go back" (or click **Undo / back**).
- Stale element list after a navigation: click **Re-scan page**.
