# ⚖ Eval Assistant

A single-page workbench for **pairwise model-response evaluation** (LEFT vs RIGHT)
on repo-based coding tasks. It mirrors the Labelbox evaluation form **1:1** so you
can fill the tool, hit **Copy All**, and paste straight into the form — while it
quietly catches inconsistencies before you submit.

Built with Vite + React, a single component file (`src/App.jsx`), inline styles,
no UI libraries, and **zero network/AI/telemetry calls**. Everything runs locally
and persists to `localStorage`.

---

## The data model: LEFT vs RIGHT

Responses are labelled **LEFT** and **RIGHT** (not A/B), matching the form. Every
field, export line, and history entry uses the same vocabulary
(`strengthLeft`, `weakRight`, `transcriptLeft`, …).

### Per-response "Classifications" block (one per side)

Each side — LEFT and RIGHT — has its own Classifications block containing:

1. **Strengths of Response** — one free-text box with a live character counter
   (minimum `MIN_STRENGTH_CHARS`).
2. **Identify issues (select all that apply)** — checkboxes for all **12 issue
   codes**. Ticking a code reveals two required fields:
   - **Justification** — why it's an issue (min `MIN_ISSUE_JUSTIFY_CHARS`).
   - **Transcript evidence (quote / line)** — the exact anchor in the transcript
     (min `MIN_ISSUE_EVIDENCE_CHARS`). See [Evidence anchoring](#evidence-anchoring).

### Shared fields

3. **Overall Preference** — one 0–7 scale shared across both responses.
   `0` is the strongest preference for **LEFT**; `7` is the strongest preference
   for **RIGHT**. The color ramp runs green (LEFT) → red (RIGHT).

   | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
   |---|---|---|---|---|---|---|---|
   | LEFT strongly | LEFT preferred | LEFT slightly | LEFT marginally | RIGHT marginally | RIGHT slightly | RIGHT preferred | RIGHT strongly |

4. **Rationale** — one free-text box, minimum `MIN_RATIONALE_CHARS`.

### The 12 issue codes

| Code | Label |
|------|-------|
| `INST` | Instruction Following Failures |
| `OVERENG` | Overengineering |
| `TOOL` | Tool Use Errors |
| `LAZY` | Laziness |
| `VERIFY` | Verification Failures |
| `FALSE` | False Claims of Success |
| `ROOT` | Fails to Address Root Cause |
| `DESTRUCT` | Unauthorized Destructive Operations |
| `FILE` | File-Related Issues |
| `HALLUC` | Code Hallucinations |
| `DOCS` | Documentation Issues |
| `VERBOSE` | Verbose Dialogue / Formatting |

### Tunable minimums (all in one place)

The character minimums are constants at the **top of `src/App.jsx`** so you can
change them without hunting through the code:

```js
const MIN_STRENGTH_CHARS = 50;        // per-response "Strengths" (not yet confirmed — tune here)
const MIN_ISSUE_EVIDENCE_CHARS = 20;  // per-issue transcript evidence
const MIN_ISSUE_JUSTIFY_CHARS = 20;   // per-issue justification
const MIN_RATIONALE_CHARS = 50;       // shared rationale (confirmed by the form)
```

> `MIN_STRENGTH_CHARS` is set to `50` as a placeholder — the real form minimum
> isn't confirmed. Because it's a single constant, you change it in one line.

---

## Comparison Worksheet

The worksheet **replaces** the old regex-based auto-rating heuristic. It does
**not** write any strengths, issues, or rationale text — it only helps you reason
and proposes a preference you must confirm.

You score each side **1–5** on five weighted dimensions:

| Dimension | Weight |
|-----------|:------:|
| Correctness | 3 |
| Instruction-following | 3 |
| Completeness | 2 |
| Safety / No destructive ops | 2 |
| Conciseness / Formatting | 1 |

Total weight = **11**, so each side's weighted total ranges from **11** (all 1s)
to **55** (all 5s).

### Bucket-mapping formula

Let `leftTotal` and `rightTotal` be the weighted sums, and

```
diff = leftTotal − rightTotal          (positive favors LEFT, negative favors RIGHT)
mag  = |diff|
```

Pick a **strength tier** from the magnitude:

| `mag` range | Tier (`level`) |
|-------------|----------------|
| `0 – 4`   | marginal (0) |
| `5 – 12`  | slightly (1) |
| `13 – 24` | preferred (2) |
| `25+`     | strongly (3) |

Then map to a 0–7 bucket:

```
diff > 0  (LEFT favored)  → bucket = 3 − level     // 3 marginal … 0 strongly
diff < 0  (RIGHT favored) → bucket = 4 + level     // 4 marginal … 7 strongly
diff = 0  (exact tie)     → no suggestion (the scale has no neutral; decide manually)
```

**Worked example:** LEFT scores total **41**, RIGHT **33** → `diff = +8`, `mag = 8`
→ tier *slightly* (1) → `bucket = 3 − 1 = 2` → the tool displays:

> *"LEFT weighted 41 vs RIGHT 33 → suggests **2: LEFT slightly preferred**"*
> tagged **"SUGGESTION — you must confirm"**.

Selecting the official 0–7 radio on the **Preference** step stays a separate,
manual action.

---

## Evidence anchoring

Every ticked issue stores a **`evidence`** string alongside its `justification`:

```js
{ code: "FALSE", justification: "Claims the tests pass…", evidence: 'L142: "all tests pass" (no test command was run)' }
```

- The evidence field is **required** and validated against `MIN_ISSUE_EVIDENCE_CHARS`.
- It's included in both **Copy All** and the **JSON export**.
- It forces you to anchor each issue to a concrete quote or line, so reviewers can
  verify your call.

The **transcript parser** (the read-only "Files edited / TODOs / success claims"
panel) is a **reading aid** for finding those anchors faster. It never writes into
any answer field.

---

## Validator rules

Run on the **Submit** step.

### Blocking errors (must fix before submitting)

- LEFT or RIGHT strengths shorter than `MIN_STRENGTH_CHARS`.
- Any ticked issue whose justification `< MIN_ISSUE_JUSTIFY_CHARS`
  **or** evidence `< MIN_ISSUE_EVIDENCE_CHARS`.
- No Overall Preference selected.
- Rationale shorter than `MIN_RATIONALE_CHARS`.

### Non-blocking warnings (review, but you may proceed)

- **Worksheet vs preference** — if the worksheet's weighted totals favor one side
  but the chosen preference favors the other (e.g. LEFT total higher but preference
  ≥ 4), it warns.
- **Issue tags vs preference** — if one side has strictly more ticked issues (i.e.
  looks worse) yet the preference favors that same side, it warns.
- **Preference vs rationale wording** — a keyword heuristic: if the preference
  favors LEFT but the rationale reads pro-RIGHT (or vice-versa), it warns.

---

## How to use this for one evaluation

1. **Paste** — drop the task prompt (optional) and both transcripts into the
   **LEFT** and **RIGHT** boxes. Markdown is fine. The parser panel summarizes
   structure to help you read.
2. **Worksheet** — score each side 1–5 on the five dimensions. Read the suggested
   bucket and its arithmetic, but don't treat it as the answer.
3. **LEFT** — write LEFT's *Strengths of Response*, then tick any issue codes and
   fill each one's **justification** and **transcript evidence**.
4. **RIGHT** — do the same for RIGHT.
5. **Preference** — pick the single 0–7 Overall Preference, then write the Rationale.
6. **Submit** — clear any blocking errors, glance at the consistency warnings, then
   hit **Copy All** (pastes 1:1 into the form) or **JSON** to export.
7. **Save & New** — archives the eval to local History and resets for the next one.

Header controls — **Task ID**, a **timer** (pause/resume), **Copy All**, **JSON**,
and **Save & New** — are available on every step.

---

## Design philosophy

This tool **structures judgment and catches inconsistencies — it never writes your
answers and never auto-submits.** The worksheet proposes; the validator warns; the
parser points. Every word of strengths, every issue justification, every piece of
evidence, the preference, and the rationale are authored by you. Suggestions are
always advisory and clearly labelled, there are no network or AI calls, and nothing
leaves your browser. The goal is faster, more consistent *human* evaluation — not
automated evaluation.

---

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173/eval-assistant/
npm run build    # production bundle in dist/
```

## Deploy

### Netlify
```bash
npm install -g netlify-cli
netlify deploy --prod --dir=dist
```

### Vercel
```bash
npm install -g vercel
vercel --prod
```

### GitHub Pages
```bash
npm run build
# push dist/ contents to gh-pages branch
```

## Tech

Vite + React 19. Single-file app (`src/App.jsx`), inline styles, no external UI
libraries. State persists to `localStorage` (current draft + history of the last
50 evaluations). No network, AI, or telemetry calls.
