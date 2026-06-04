/* ════════════════════════════════════════════════════════════════════════
   scoring.js — the pure "engine" of Eval Assistant
   ────────────────────────────────────────────────────────────────────────
   Everything here is a PURE function or static data: no React, no DOM, no
   localStorage. Same input → same output. That makes this module trivial to
   unit-test (see scoring.test.js) and reusable from anywhere.

   The UI in App.jsx imports these and only handles state + rendering.
   ════════════════════════════════════════════════════════════════════════ */

/* ───── Overall Preference scale (0 = LEFT strongest … 7 = RIGHT strongest) ─────
   Color ramp: LEFT side green, RIGHT side red. */
export const SCALE = [
  { val: 0, label: "LEFT strongly preferred", c: "#0d6832" },
  { val: 1, label: "LEFT preferred", c: "#1a8a45" },
  { val: 2, label: "LEFT slightly preferred", c: "#4aaa6a" },
  { val: 3, label: "LEFT marginally preferred", c: "#7cc095" },
  { val: 4, label: "RIGHT marginally preferred", c: "#c07878" },
  { val: 5, label: "RIGHT slightly preferred", c: "#b05050" },
  { val: 6, label: "RIGHT preferred", c: "#993333" },
  { val: 7, label: "RIGHT strongly preferred", c: "#7a1a1a" },
];

/* ───── Default issue taxonomy (12 codes — labels verbatim from the form) ─────
   These are DEFAULTS; the user can edit/add/remove them in the UI (the live
   list is held in App state and persisted to localStorage). */
export const DEFAULT_TAXONOMY = [
  { code: "INST", label: "Instruction Following Failures", desc: "Ignored or misunderstood explicit instructions" },
  { code: "OVERENG", label: "Overengineering", desc: "Unnecessarily complex; unrequested features" },
  { code: "TOOL", label: "Tool Use Errors", desc: "Incorrect use of tools, APIs, or commands" },
  { code: "LAZY", label: "Laziness", desc: "Incomplete, gives up early, TODOs/placeholders" },
  { code: "VERIFY", label: "Verification Failures", desc: "Claims without checking" },
  { code: "FALSE", label: "False Claims of Success", desc: "Says it works when it doesn't" },
  { code: "ROOT", label: "Fails to Address Root Cause", desc: "Fixes symptoms not the cause" },
  { code: "DESTRUCT", label: "Unauthorized Destructive Operations", desc: "Unsafe/irreversible actions" },
  { code: "FILE", label: "File-Related Issues", desc: "Wrong paths, wrong files modified" },
  { code: "HALLUC", label: "Code Hallucinations", desc: "References non-existent functions/files/APIs" },
  { code: "DOCS", label: "Documentation Issues", desc: "Unwanted docs or bad comments" },
  { code: "VERBOSE", label: "Verbose Dialogue / Formatting", desc: "Too long, filler, excessive markdown" },
];

/* ───── Default Comparison Worksheet dimensions (weighted scoring) ─────
   DEFAULTS; user-editable in the UI. Each `key` must be unique and stable —
   the worksheet scores are keyed by it. */
export const DEFAULT_DIMENSIONS = [
  { key: "correctness", label: "Correctness", weight: 3, desc: "Does the change actually work / solve the task?" },
  { key: "instruction", label: "Instruction-following", weight: 3, desc: "Did it do what was asked, no more, no less?" },
  { key: "completeness", label: "Completeness", weight: 2, desc: "Fully done — no TODOs, stubs, half-measures?" },
  { key: "safety", label: "Safety / No destructive ops", weight: 2, desc: "Avoided unsafe/irreversible actions?" },
  { key: "conciseness", label: "Conciseness / Formatting", weight: 1, desc: "Tight, well-formatted, no filler?" },
];

/** Sum of all dimension weights for a given dimension set. */
export function totalWeight(dimensions) {
  return dimensions.reduce((s, d) => s + (Number(d.weight) || 0), 0);
}

/** Maximum achievable weighted total (every dimension scored 5). */
export function maxWeighted(dimensions) {
  return totalWeight(dimensions) * 5;
}

/** Build an empty worksheet: { <key>: { L: null, R: null }, ... }. */
export function blankWorksheet(dimensions) {
  return Object.fromEntries(dimensions.map(d => [d.key, { L: null, R: null }]));
}

/** Weighted total for one side ("L" or "R"). Unscored dims count as 0. */
export function weightedTotal(worksheet, side, dimensions) {
  return dimensions.reduce((sum, d) => {
    const v = worksheet?.[d.key]?.[side];
    return sum + (typeof v === "number" ? v * (Number(d.weight) || 0) : 0);
  }, 0);
}

/** True only if every dimension is scored 1–5 for BOTH sides. */
export function worksheetComplete(worksheet, dimensions) {
  return dimensions.length > 0 && dimensions.every(d => {
    const cell = worksheet?.[d.key] || {};
    return typeof cell.L === "number" && typeof cell.R === "number";
  });
}

/**
 * Map the LEFT-vs-RIGHT weighted difference to a SUGGESTED 0–7 bucket.
 *   diff = leftTotal - rightTotal   (positive favors LEFT → buckets 3..0,
 *                                     negative favors RIGHT → buckets 4..7)
 * Magnitude bands (tuned for the default weight total) pick the strength tier.
 * Returns { diff, mag, level, bucket } where bucket is null on a tie.
 */
export function suggestBucket(leftTotal, rightTotal) {
  const diff = leftTotal - rightTotal;
  const mag = Math.abs(diff);
  let level;                       // 0=marginal,1=slightly,2=preferred,3=strongly
  if (mag <= 4) level = 0;
  else if (mag <= 12) level = 1;
  else if (mag <= 24) level = 2;
  else level = 3;

  let bucket;
  if (diff > 0) bucket = 3 - level;      // LEFT favored: 3 (marginal) → 0 (strongly)
  else if (diff < 0) bucket = 4 + level; // RIGHT favored: 4 (marginal) → 7 (strongly)
  else bucket = null;                    // exact tie — no neutral option exists
  return { diff, mag, level, bucket };
}
