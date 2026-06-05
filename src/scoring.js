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

/* ════════════════════════════════════════════════════════════════════════
   Transcript reading aid + evidence-based SUGGESTION engine (pure)
   ────────────────────────────────────────────────────────────────────────
   parseTranscript() turns a pasted agent transcript into structural signals.
   It is format-aware: it understands both raw tool-call logs (str_replace,
   create_file, …) AND the common agent-markdown format (### Tool/Edit/View,
   **search_command**, Replace/With blocks).

   analyzePair() compares two parsed transcripts on EVIDENCE that a regex can
   actually observe — input validation, index handling, placeholder stubs,
   self-correction churn, runtime errors — and proposes a 0–7 bucket. It can
   see STRUCTURE, not semantic correctness, so it is a SUGGESTION only; the
   human still reads the diff and fills the worksheet.
   ════════════════════════════════════════════════════════════════════════ */

export function parseTranscript(text) {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const toolCalls = [];
  const filesEdited = new Set();
  const filesRead = new Set();
  const filesExplored = new Set();
  const commands = [];
  const placeholderTodos = []; // genuine incompleteness (laziness)
  const benignTodos = [];      // forward-looking design notes (NOT laziness)
  const successClaims = [];
  const errors = [];
  const reverts = [];          // self-correction / thrash
  let editOps = 0;

  // A tool invocation across dialects (raw calls + agent-markdown headers)
  const toolLine = /(?:^|\s)(?:###\s*Tool|###\s*Edit|###\s*View|###\s*Run|###\s*Read|str_replace(?:_editor)?|create_file|write_file|file_edit|insert_text|read_file|view_file|bash_exploration_tool|bash\b|execute(?:_bash)?|terminal|shell|\bgrep\b|\brg\b|\bag\b|\bfind\b|list_dir|search_command)/i;
  // File-path tokens (absolute or with a known source extension)
  const fileToken = /(?:\/[\w.-]+)+\.(?:py|js|ts|jsx|tsx|rs|go|rb|java|kt|c|cpp|cc|h|hpp|cs|scala|css|scss|html|json|yaml|yml|toml|md|txt|cfg|ini|sh|sql)\b|\b[\w.-]+\.(?:py|js|ts|jsx|tsx|rs|go|rb|java|kt|c|cpp|cc|h|hpp|cs|scala|css|scss|html|json|yaml|yml|toml|md|txt|cfg|ini|sh|sql)\b/g;
  const editLine = /(?:###\s*Edit\b|str_replace(?:_editor)?|create_file|write_file|file_edit|insert_text)/i;
  const readLine = /(?:###\s*View\b|###\s*Read\b|read_file|view_file|\bcat\s|\bhead\s|\btail\s|\bless\s)/i;
  const exploreLine = /\b(?:grep|rg|ag|find|ripgrep|list_dir)\b/i;
  const todoLine = /(?:TODO|FIXME|XXX|HACK|placeholder|NotImplementedError|your code here|fill in|implement\s+this|left as|pass\s*#|\.\.\.\s*(?:#|$))/i;
  const placeholderHint = /(?:your code here|not\s*implemented|notimplementederror|fill in|implement\s+this|placeholder|left as|pass\s*#|stub|\.\.\.\s*$)/i;
  const successLine = /(?:successfully|all tests pass|this (?:should|will) (?:fix|work|resolve)|fix(?:ed|es) the (?:issue|bug|problem)|changes are (?:complete|done)|solution is (?:complete|done)|looks (?:good|correct)|works as expected)/i;
  // Real runtime failures only — NOT grep/exploration misses ("No such file").
  const errorLine = /(?:Traceback|command not found|NameError|ImportError|SyntaxError|AttributeError|AssertionError|IndentationError|KeyError:)/;
  // NB: keep whole-word anchors OFF the punctuation-ending alternatives — `\bwait,\b`
  // never matches ("," is a non-word char, so the trailing \b fails). Anchor only the
  // bare words; let the phrase alternatives match literally.
  const revertLine = /\b(?:wait|actually|reconsider|undo|oops)\b|re-?think|let me revert|i'?ll revert|revert(?:ing)?|my mistake|on second thought|scratch that|that'?s wrong|wrong (?:direction|approach)|incorrect approach/i;
  const searchCmd = /\*\*(?:search_)?command:?\*\*\s*`([^`]+)`/i;

  // Whole-transcript evidence signals
  const hasLengthCheck = /length of values|len\(self\)\s*!=\s*len|does not match length|raise\s+ValueError/i.test(text);
  const hasIndexHandling = /reset_index|set_index|default_index_type|distributed-sequence|ops_on_diff_frames/i.test(text);
  const hasTestRun = /pytest|unittest|tox\b|run the tests|tests? pass|assert\s+/i.test(text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (toolLine.test(line)) toolCalls.push({ line: i + 1, text: line.trim().substring(0, 120) });
    if (editLine.test(line)) { editOps += 1; (line.match(fileToken) || []).forEach(f => filesEdited.add(f)); }
    if (readLine.test(line)) (line.match(fileToken) || []).forEach(f => filesRead.add(f));
    if (exploreLine.test(line)) (line.match(fileToken) || []).forEach(f => filesExplored.add(f));
    const sc = line.match(searchCmd);
    if (sc) commands.push(sc[1].trim().substring(0, 120));
    if (todoLine.test(line)) {
      const entry = { line: i + 1, text: line.trim().substring(0, 100) };
      (placeholderHint.test(line) ? placeholderTodos : benignTodos).push(entry);
    }
    if (successLine.test(line)) successClaims.push({ line: i + 1, text: line.trim().substring(0, 100) });
    if (errorLine.test(line)) errors.push({ line: i + 1, text: line.trim().substring(0, 100) });
    if (revertLine.test(line)) reverts.push({ line: i + 1, text: line.trim().substring(0, 100) });
  }

  const bashContent = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  let m;
  while ((m = bashContent.exec(text)) !== null) commands.push(m[1].trim().substring(0, 120));

  return {
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.slice(0, 30),
    filesEdited: [...filesEdited].slice(0, 20),
    filesRead: [...filesRead].slice(0, 20),
    filesExplored: [...filesExplored].slice(0, 20),
    commands: [...new Set(commands)].slice(0, 15),
    editOps,
    placeholderTodos,
    benignTodos,
    todos: placeholderTodos, // back-compat: the red "TODO" warning shows real stubs only
    successClaims,
    errors: errors.slice(0, 20),
    reverts,
    hasLengthCheck,
    hasIndexHandling,
    hasTestRun,
    lineCount: lines.length,
    charCount: text.length,
  };
}

/** Collapse a parsed transcript into the few scalars the suggestion uses. */
export function evidenceSignals(parsed) {
  if (!parsed) return { val: 0, idx: 0, rev: 0, ph: 0, err: 0, edits: 0 };
  return {
    val: parsed.hasLengthCheck ? 1 : 0,
    idx: parsed.hasIndexHandling ? 1 : 0,
    rev: parsed.reverts.length,
    ph: parsed.placeholderTodos.length,
    err: parsed.errors.length,
    edits: parsed.editOps,
  };
}

/** Map a signed evidence score to a 0–7 bucket (positive = RIGHT advantage). */
export function evidenceBucket(score) {
  const mag = Math.abs(score);
  let level;                       // 0 marginal,1 slightly,2 preferred,3 strongly
  if (mag <= 0.4) level = 0;
  else if (mag <= 1.2) level = 1;
  else if (mag <= 2.4) level = 2;
  else level = 3;
  let bucket;
  if (score > 0.15) bucket = 4 + level;       // RIGHT favored: 4..7
  else if (score < -0.15) bucket = 3 - level; // LEFT favored: 3..0
  else bucket = null;                          // too close to call
  const confidence = mag >= 2.4 ? "high" : mag >= 1.2 ? "medium" : mag >= 0.4 ? "low-medium" : "low";
  return { score, mag, level, bucket, confidence };
}

/* ════════════════════════════════════════════════════════════════════════
   Pluggable evidence DETECTORS — domain knowledge as DATA, not branches
   ────────────────────────────────────────────────────────────────────────
   A detector observes a parsed transcript (and, if it wants, the raw text)
   and reports whether a signal is present. The aggregator in analyzePair() is
   completely generic — it knows nothing about pandas, Rust, JS, etc. Domain
   expertise lives in detector "packs" you opt into. To make the engine smarter
   for a new domain you ADD a detector; you never edit the core.

   Each detector:
     id        unique string
     label     human label (shown in key differences)
     tier      "correctness" (a proxy the fix is actually RIGHT — domain-ish)
               "process"     (generalizes everywhere but says NOTHING about
                              correctness: explored, ran tests, edit volume…)
     polarity  "good" (presence is positive for that side) | "bad"
     weight    magnitude of its contribution
     cap?      optional clamp on its absolute contribution
     test(parsed, rawText) -> boolean
     weakness?(self, other) -> { code, justification } | null
   ════════════════════════════════════════════════════════════════════════ */

/** Domain-agnostic detectors — safe to run on ANY codebase/language. */
export const GENERIC_DETECTORS = [
  { id: "placeholderStub", label: "Placeholder/stub in final code", tier: "correctness", polarity: "bad", weight: 0.6,
    test: p => p.placeholderTodos.length > 0,
    weakness: s => s.placeholderTodos.length > 0
      ? { code: "LAZY", justification: `placeholder/stub left in code ("${s.placeholderTodos[0].text}", line ${s.placeholderTodos[0].line}).` } : null },
  { id: "unresolvedError", label: "Unresolved runtime error", tier: "correctness", polarity: "bad", weight: 0.5,
    test: p => p.errors.length > 0,
    weakness: s => s.errors.length > 0
      ? { code: "FALSE", justification: `runtime error visible in transcript ("${s.errors[0].text.substring(0, 40)}") — confirm it was resolved.` } : null },
  { id: "unverifiedSuccess", label: "Success claimed, never verified", tier: "process", polarity: "bad", weight: 0.2,
    test: p => p.successClaims.length > 0 && !p.hasTestRun && p.commands.length === 0,
    weakness: s => (s.successClaims.length > 0 && !s.hasTestRun && s.commands.length === 0)
      ? { code: "VERIFY", justification: `claims success ("${s.successClaims[0].text.substring(0, 48)}") but ran no test/verification.` } : null },
  { id: "ranTests", label: "Ran tests/verification", tier: "process", polarity: "good", weight: 0.35,
    test: p => p.hasTestRun },
  { id: "exploredBeforeEdit", label: "Explored before editing", tier: "process", polarity: "good", weight: 0.2,
    test: p => p.filesExplored.length > 0 && p.filesEdited.length > 0 },
  { id: "highChurn", label: "High self-correction churn", tier: "process", polarity: "bad", weight: 0.1, cap: 0.25,
    test: p => p.reverts.length >= 3,
    weakness: s => (s.reverts.length >= 3 && s.editOps > 0)
      ? { code: "VERBOSE", justification: `high self-correction churn (${s.reverts.length} reverts/re-thinks) — weaker initial grasp. [Tiebreaker only.]` } : null },
];

/** Opt-in pandas/Koalas pack — correctness proxies specific to that domain.
    This is exactly the kind of knowledge that does NOT belong in the core. */
export const PANDAS_DETECTORS = [
  { id: "inputValidation", label: "Input/length validation", tier: "correctness", polarity: "good", weight: 1.0,
    test: p => p.hasLengthCheck,
    weakness: (s, o) => (!s.hasLengthCheck && o.hasLengthCheck)
      ? { code: "INST", justification: `no length/size validation, while the other side raises on mismatch — may silently produce wrong output.` } : null },
  { id: "indexHandling", label: "Explicit index handling", tier: "correctness", polarity: "good", weight: 0.9,
    test: p => p.hasIndexHandling,
    weakness: (s, o) => (!s.hasIndexHandling && o.hasIndexHandling)
      ? { code: "ROOT", justification: `no explicit index handling (reset_index/set_index/default_index_type) — can misalign values for non-default indexes.` } : null },
];

/**
 * Compare two transcripts using a set of DETECTORS and suggest a 0–7 bucket.
 * LEFT = first arg, RIGHT = second arg. `opts.detectors` defaults to the
 * domain-agnostic GENERIC pack; pass `[...GENERIC_DETECTORS, ...PANDAS_DETECTORS]`
 * (or your own) to add domain intelligence. Returns a SUGGESTION, never a final
 * answer — and deliberately REFUSES to claim a strong preference when the lead
 * is carried only by process/thoroughness signals.
 */
export function analyzePair(leftText, rightText, opts = {}) {
  const detectors = opts.detectors || GENERIC_DETECTORS;
  const L = parseTranscript(leftText);
  const R = parseTranscript(rightText);
  if (!L || !R) return null;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  let score = 0;            // positive = RIGHT better
  let correctnessScore = 0; // contribution from correctness-tier detectors ONLY
  const detectorHits = [];
  for (const d of detectors) {
    const l = !!d.test(L, leftText);
    const r = !!d.test(R, rightText);
    if (!l && !r) continue;
    let contrib = d.polarity === "good"
      ? d.weight * ((r ? 1 : 0) - (l ? 1 : 0))
      : d.weight * ((l ? 1 : 0) - (r ? 1 : 0));
    if (d.cap) contrib = clamp(contrib, -d.cap, d.cap);
    score += contrib;
    if (d.tier === "correctness") correctnessScore += contrib;
    detectorHits.push({ id: d.id, label: d.label, tier: d.tier, left: l, right: r, contrib: +contrib.toFixed(3) });
  }

  // Weaknesses come from the detectors themselves — no hard-coded domain branches.
  const collectWeak = (self, other) =>
    detectors.map(d => (d.weakness ? d.weakness(self, other) : null)).filter(Boolean);
  const weakLeft = collectWeak(L, R);
  const weakRight = collectWeak(R, L);

  // ── Calibration: thoroughness is not correctness ──
  // If the margin is carried by PROCESS signals (tests run, exploration, edit
  // volume) rather than CORRECTNESS evidence, refuse to claim more than a
  // marginal lean and drop confidence. A confident, well-tested WRONG fix must
  // not outrank a terse correct one.
  const cautions = [];
  const processLed = Math.abs(correctnessScore) < 0.5 && Math.abs(score) >= 0.3;
  if (processLed) {
    cautions.push(
      "Lead is driven by process/thoroughness signals (tests run, exploration, edit volume), NOT correctness evidence. A confident, well-tested WRONG fix can outscore a terse correct one — read the diff before trusting this."
    );
  }
  if ((L.successClaims.length > 0) !== (R.successClaims.length > 0)) {
    const side = L.successClaims.length > 0 ? "LEFT" : "RIGHT";
    cautions.push(`${side} asserts success and the other does not — a success claim is not evidence of correctness; verify against the actual code.`);
  }

  let { bucket, confidence } = evidenceBucket(score);
  if (processLed) {
    confidence = "low";
    bucket = score > 0.15 ? 4 : score < -0.15 ? 3 : null; // marginal at most
  } else {
    // Confidence should track the CORRECTNESS margin, not raw thoroughness.
    confidence = evidenceBucket(correctnessScore || score).confidence;
  }

  const cmp = (name, a, b) => (a !== b ? `${name}: LEFT=${a}, RIGHT=${b}` : null);
  const keyDifferences = [
    cmp("Files edited", L.filesEdited.length, R.filesEdited.length),
    cmp("Edit ops", L.editOps, R.editOps),
    cmp("Ran tests", L.hasTestRun ? "yes" : "no", R.hasTestRun ? "yes" : "no"),
    cmp("Placeholder stubs", L.placeholderTodos.length, R.placeholderTodos.length),
    cmp("Self-corrections", L.reverts.length, R.reverts.length),
    cmp("Runtime errors", L.errors.length, R.errors.length),
    ...detectors
      .filter(d => d.tier === "correctness" && (d.test(L, leftText) || d.test(R, rightText)))
      .map(d => cmp(d.label, d.test(L, leftText) ? "yes" : "no", d.test(R, rightText) ? "yes" : "no")),
  ].filter(Boolean);

  return {
    parsedLeft: L,
    parsedRight: R,
    score: +score.toFixed(3),
    correctnessScore: +correctnessScore.toFixed(3),
    bucket,
    confidence,
    detectorHits,
    cautions,
    suggestedLabel: bucket === null ? "Too close to call from evidence" : SCALE[bucket].label,
    weakLeft,
    weakRight,
    keyDifferences: keyDifferences.length ? keyDifferences : ["No structural differences detected — compare final code manually."],
    note: "Suggestion from observable structure via pluggable detectors. The core is domain-agnostic; correctness detectors are an opt-in pack. It cannot read semantics — confirm by reading the diff.",
  };
}
