# DEMO.md — "I talk to my own Chrome, and it acts before I finish the sentence"

Target length 3–5 minutes. One window: your normal Chrome with the **Voice Browser side panel**
open on the right and the page on the left. Speak short, natural commands; pause ~1 s between them.

## Before recording

```bash
cd voice-browser-extension
npm install && npm run build
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`. Gear icon in the panel →
   Settings → paste the TypeSafe key → **Test connection** (`✓ jev-1.13.0 answered in ~300 ms`).
2. Open `https://example.com`, click the toolbar icon → side panel. Tap the **mic**; a tab asks for
   the microphone once → **Allow**; it closes itself and the amber ring starts pulsing: "Listening…".
3. Say "scroll down" once to warm up the API connection (first call ~700 ms, later ones ~300 ms).
4. Optional dry run without talking: `npm run test:e2e:headed` replays the whole script below
   (plus the pop-up and go-back checks) in a throw-away Chromium profile.
5. For the pop-up part, serve the local test page: `node -e "import('./test/e2e/serve-pages.mjs').then(m=>m.servePages()).then(s=>console.log(s.url+'/modal.html'))"`
   and open the printed URL in a tab (or use any site with a cookie banner).

If the room is noisy the `is_command` gate ignores side talk anyway — that is a demo point.

---

## 0:00 — Hook (15 s)

> **"Go to wikipedia."**

The tab navigates as the word "wikipedia" lands. The panel shows your words as a bubble and a card:
**Opened en.wikipedia.org · 0.6 s after your last word**.

Line: *"That wasn't an LLM writing a plan. A model answered twelve yes/no and multiple-choice
questions in three hundred milliseconds, and code did the rest — inside a normal Chrome extension."*

## 0:20 — What Jev is (30 s)

Open **Details** at the bottom of the panel; point at *Last decision* and the intent bars.

- Jev is TypeSafe's *System One* model: it does not generate text. You send a state and typed
  questions, you get one typed answer per question — probabilities, not prose.
- All questions are answered **in parallel**, so we ask everything speculatively in one request:
  intent, which element, which site, "is the sentence finished?", "is this even for me?", "is it
  destructive?", scroll amount, which verbatim span is the search text, "is this a correction?".
- $0.042 per million input tokens, output free. The Details pill: a whole demo is about a cent.

Collapse Details again — *"this is the developer view; nobody needs it to use the thing."*

## 0:50 — Acting on partial speech (45 s)

Say slowly, with a small pause after "for":

> **"Search for … Alan Turing."**

While you pause the status line says "waiting for the rest…" — it *waits* (`complete 0.03 ✗` in
Details). Then it types into Wikipedia's own search box and presses Enter (amber highlight + toast
in the page).

Line: *"`complete` is why it can act early without acting wrong. And the text it typed was never
generated — code cut candidate spans out of the transcript, Jev only picked one."*

> **"Scroll down a bit."** · **"Scroll to the bottom."**

> **"Go back."**

Exactly one step. *"The recognizer often delivers the same phrase twice — as a re-indexed final
result, or again after it restarts. The panel's Details → Speech events show every delivery; the
controller consumes duplicates within 2.5 s and ignores an identical back/scroll within 1.5 s unless
you say 'again'."*

## 1:35 — Clicking things: the element snapshot (45 s)

> **"Go to hacker news."**

Details → *Elements sent to Jev*: ~100 interactive elements with short ids, viewport first, 60 chars
each — collected by the content script on the page you are looking at.

> **"Click the new link."**

The element flashes amber before the click; the card says **Clicked “new”**.

> **"Click on a link."**

Ambiguous → numbered amber badges appear on the candidates in the page, and the panel asks
**Which one?** with numbered buttons. Say:

> **"Two."**

Line: *"No model call for the number — that's a regex. Jev answers judgment, code answers
arithmetic."*

## 2:20 — Pop-ups (30 s)

Switch to the tab with the newsletter dialog / cookie banner (step 5 above, or any site with one).
The panel notices: **A pop-up is covering the page — say “close this”, “accept cookies” or “not
now”**.

> **"Close this."**

The dialog's × button is pressed — even the button that lives in a shadow root, or a same-origin
iframe, is visible to the collector. Then the cookie strip is detected as a banner:

> **"Accept cookies."**

Line: *"The pop-up's controls are always first in Jev's list and the state says `modal_open: true`
with the pop-up's text, so 'close this' can't be confused with 'close this tab'."*

## 2:50 — Corrections, context, safety (40 s)

> **"Go to example dot com."** · **"Click the more information link."**

Then, as if annoyed:

> **"No, not that one."**

The tab goes back; Details shows `is_correction 0.9 ✓ — rejects previous action`. *"Jev has no
memory between requests; the memory lives in the state — per tab."*

Side-talk to someone off camera in a normal voice:

> **"…so anyway I think we should get lunch after this."**

Status: "that didn't sound like a command". Nothing moved (`is_command 0.02`).

Destructive gate (optional, needs a page with a buy/submit/delete button): "click place order" →
the **Are you sure?** card with Confirm / Cancel → say "cancel".

## 3:30 — Two commands in one breath, tabs (20 s)

> **"Open a new tab and go to wikipedia."**

The tab opens as soon as "open a new tab" is complete; the remaining words become a second command
(even when the whole sentence arrives at once, the controller splits at "and" for commands without
free text).

> **"Close this tab."**

Switch to another tab by hand and say "scroll down": the side panel follows the active tab.

## 3:50 — Show the code (30 s)

Open `src/constants.js`:

- `MODEL = "jev-1.13.0"` — pinned; aliases move and thresholds are tuned per version.
- `INTENT_CRITERIA`: every option is `{what, not_for, examples}` — including `close_popup`.
- `T` — the thresholds in the gate table; `DUPLICATE_TRANSCRIPT_MS`, `REPEAT_ACTION_MS`,
  `DISMISS_PATTERNS`. *"This is the entire policy. Change a number, not a prompt."*

## 4:20 — Numbers and close (20 s)

```bash
npm run test:integration    # 42/42 real-API cases (8 about pop-ups), latency avg ≈ 350 ms
npm run test:e2e            # 21 steps in headless Chromium: real sites + local modal / history pages
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
- "close this" · "dismiss the popup" · "accept all" · "no thanks" · "not now"
- "type hello world into the search box" · "press enter"
- "scroll down a page" · "scroll up" · "back to the top" · "go back again"
- "reload" · "go forward" · "next tab" · "undo that"

## If something goes wrong on camera

- Mic stops after silence: Chrome ends continuous sessions after ~60 s; the panel restarts it (the
  ring keeps pulsing). "Microphone is blocked" card → its button opens Chrome's site settings.
- Nothing happens: the status line says why ("waiting for the rest…", "that didn't sound like a
  command"); Details → Last decision names the failing threshold. Say it more explicitly.
- "Already did that a moment ago": you were heard twice; say "again" if you meant it.
- "This page can't be controlled": you are on a `chrome://` page, the Web Store or a PDF — say
  "go to …" to leave it.
- Wrong element: say "no, not that one" or "go back" (or Details → **Undo / back**).
- Stale element list after a navigation: Details → **Re-scan page**.
