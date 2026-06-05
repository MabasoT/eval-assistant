/* ════════════════════════════════════════════════════════════════════════
   scoring.test.js — unit tests for the pure scoring engine.
   ────────────────────────────────────────────────────────────────────────
   Uses Node's built-in test runner (node:test) — no extra dependencies.
   Run with:  npm test     (i.e. `node --test`)

   Because scoring.js is pure (no React/DOM/storage), we can import and call
   the functions directly. This is the payoff of keeping the engine separate
   from the UI: the logic is testable in isolation.
   ════════════════════════════════════════════════════════════════════════ */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DIMENSIONS,
  totalWeight,
  maxWeighted,
  blankWorksheet,
  weightedTotal,
  worksheetComplete,
  suggestBucket,
  parseTranscript,
  evidenceSignals,
  evidenceBucket,
  analyzePair,
  GENERIC_DETECTORS,
  PANDAS_DETECTORS,
} from "./scoring.js";

/* A small fixed dimension set we control, so tests don't depend on the
   default weights staying constant. Total weight = 3+1 = 4. */
const DIMS = [
  { key: "a", label: "A", weight: 3 },
  { key: "b", label: "B", weight: 1 },
];

/* ───── totalWeight / maxWeighted ───── */
test("totalWeight sums dimension weights", () => {
  assert.equal(totalWeight(DIMS), 4);
  assert.equal(totalWeight(DEFAULT_DIMENSIONS), 11); // 3+3+2+2+1
});

test("maxWeighted is totalWeight * 5", () => {
  assert.equal(maxWeighted(DIMS), 20);
  assert.equal(maxWeighted(DEFAULT_DIMENSIONS), 55);
});

/* ───── blankWorksheet ───── */
test("blankWorksheet creates a {L:null,R:null} cell per dimension", () => {
  const ws = blankWorksheet(DIMS);
  assert.deepEqual(ws, { a: { L: null, R: null }, b: { L: null, R: null } });
});

/* ───── weightedTotal ───── */
test("weightedTotal multiplies each score by its weight", () => {
  const ws = { a: { L: 5, R: 2 }, b: { L: 4, R: 1 } };
  // L: 5*3 + 4*1 = 19 ; R: 2*3 + 1*1 = 7
  assert.equal(weightedTotal(ws, "L", DIMS), 19);
  assert.equal(weightedTotal(ws, "R", DIMS), 7);
});

test("weightedTotal treats unscored (null/missing) cells as 0", () => {
  const ws = { a: { L: 5, R: null } }; // b missing entirely
  assert.equal(weightedTotal(ws, "L", DIMS), 15); // 5*3, b contributes 0
  assert.equal(weightedTotal(ws, "R", DIMS), 0);
});

/* ───── worksheetComplete ───── */
test("worksheetComplete is true only when every dim is scored on both sides", () => {
  assert.equal(worksheetComplete({ a: { L: 1, R: 1 }, b: { L: 1, R: 1 } }, DIMS), true);
  assert.equal(worksheetComplete({ a: { L: 1, R: 1 }, b: { L: 1, R: null } }, DIMS), false);
  assert.equal(worksheetComplete({ a: { L: 1, R: 1 } }, DIMS), false); // b missing
  assert.equal(worksheetComplete(blankWorksheet(DIMS), DIMS), false);
  assert.equal(worksheetComplete({}, []), false); // empty dimension set is never "complete"
});

/* ───── suggestBucket: the documented mapping ───── */
test("suggestBucket reproduces the worked example (41 vs 33 → 2)", () => {
  const r = suggestBucket(41, 33);
  assert.equal(r.diff, 8);
  assert.equal(r.bucket, 2); // LEFT slightly preferred
});

test("suggestBucket is mirror-symmetric for RIGHT (33 vs 41 → 5)", () => {
  assert.equal(suggestBucket(33, 41).bucket, 5); // RIGHT slightly preferred
});

test("suggestBucket returns null bucket on an exact tie", () => {
  const r = suggestBucket(30, 30);
  assert.equal(r.diff, 0);
  assert.equal(r.bucket, null);
});

test("suggestBucket maps the strongest preferences at the extremes", () => {
  assert.equal(suggestBucket(55, 11).bucket, 0); // diff 44 → LEFT strongly
  assert.equal(suggestBucket(11, 55).bucket, 7); // diff -44 → RIGHT strongly
});

test("suggestBucket magnitude band boundaries are correct", () => {
  // mag <= 4 → marginal (level 0): LEFT bucket 3, RIGHT bucket 4
  assert.equal(suggestBucket(34, 30).bucket, 3); // diff +4
  assert.equal(suggestBucket(30, 34).bucket, 4); // diff -4
  // mag 5..12 → slightly (level 1): LEFT 2, RIGHT 5
  assert.equal(suggestBucket(35, 30).bucket, 2); // diff +5
  assert.equal(suggestBucket(42, 30).bucket, 2); // diff +12
  // mag 13..24 → preferred (level 2): LEFT 1, RIGHT 6
  assert.equal(suggestBucket(43, 30).bucket, 1); // diff +13
  assert.equal(suggestBucket(54, 30).bucket, 1); // diff +24
  // mag > 24 → strongly (level 3): LEFT 0, RIGHT 7
  assert.equal(suggestBucket(55, 30).bucket, 0); // diff +25
});

/* ════════════════════════════════════════════════════════════════════════
   Transcript parser + evidence-based suggestion engine
   Fixtures distilled from a real Koalas eval: "Column assignment doesn't
   support type list". LEFT converts the list to a Series (no length check, no
   index handling, messy/self-correcting); RIGHT validates length and assigns
   positionally via reset_index/set_index + option_context (the canonical fix).
   ════════════════════════════════════════════════════════════════════════ */
const LEFT_TX = `
### Tool: bash_exploration_tool
**search_command:** \`grep -n "Column assignment" /repo/databricks/koalas/frame.py\`

### View \`/repo/databricks/koalas/frame.py\`

Wait, the issue is supporting list, not rejecting it.
Let me re-think the approach here.

### Edit \`/repo/databricks/koalas/frame.py\`
**Replace:**
\`\`\`python
def __setitem__(self, key, value):
\`\`\`
**With:**
\`\`\`python
def __setitem__(self, key, value):
    if is_list_like(value) and not isinstance(value, (DataFrame, Series, spark.Column)):
        value = Series(value)
\`\`\`

Let me revert the earlier MultiIndex change to the original approach.

### Edit \`/repo/databricks/koalas/frame.py\`
The file /repo/databricks/koalas/frame.py has been edited successfully.
Lists will now be converted to Series. The change looks good.
`;

const RIGHT_TX = `
### Tool: bash_exploration_tool
**search_command:** \`grep -n "__setitem__" /repo/databricks/koalas/frame.py\`

### View \`/repo/databricks/koalas/frame.py\`

### Edit \`/repo/databricks/koalas/frame.py\`
**With:**
\`\`\`python
elif isinstance(value, list):
    if len(self) != len(value):
        raise ValueError("Length of values does not match length of index")
    # TODO: avoid using default index?
    with option_context(
        "compute.default_index_type", "distributed-sequence",
        "compute.ops_on_diff_frames", True,
    ):
        kdf = self.reset_index()
        kdf[key] = ks.DataFrame(value)
        kdf = kdf.set_index(kdf.columns[: self._internal.index_level])
        kdf.index.names = self.index.names
\`\`\`
The file /repo/databricks/koalas/frame.py has been edited successfully.
`;

test("parseTranscript detects agent-markdown edits (### Edit) and file paths", () => {
  const p = parseTranscript(LEFT_TX);
  assert.ok(p.editOps >= 1, "should count ### Edit ops");
  assert.ok(p.filesEdited.includes("/repo/databricks/koalas/frame.py"), "should capture edited path");
});

test("parseTranscript flags input validation and index handling on the RIGHT fix", () => {
  const r = parseTranscript(RIGHT_TX);
  assert.equal(r.hasLengthCheck, true);
  assert.equal(r.hasIndexHandling, true);
});

test("parseTranscript does NOT see validation/index handling in the LEFT fix", () => {
  const l = parseTranscript(LEFT_TX);
  assert.equal(l.hasLengthCheck, false);
  assert.equal(l.hasIndexHandling, false);
});

test("parseTranscript splits benign design-note TODOs from real placeholder stubs", () => {
  const r = parseTranscript(RIGHT_TX);
  // "# TODO: avoid using default index?" is a design note, NOT laziness.
  assert.equal(r.placeholderTodos.length, 0);
  assert.ok(r.benignTodos.length >= 1);
});

test("parseTranscript counts self-correction / thrash on the LEFT transcript", () => {
  const l = parseTranscript(LEFT_TX);
  assert.ok(l.reverts.length >= 3, `expected >=3 reverts, got ${l.reverts.length}`);
});

test("evidenceBucket maps a strong RIGHT advantage to the RIGHT 'preferred' band", () => {
  assert.equal(evidenceBucket(2.15).bucket, 6);
  assert.equal(evidenceBucket(-2.15).bucket, 1); // mirror
  assert.equal(evidenceBucket(0).bucket, null);  // too close to call
});

/* With the pandas correctness pack opted in, the engine reproduces the hand
   evaluation: RIGHT preferred (bucket 6). Domain knowledge is DATA you pass in,
   not a baked-in branch — that is the whole point of the detector framework. */
const PANDAS_PACK = { detectors: [...GENERIC_DETECTORS, ...PANDAS_DETECTORS] };

test("analyzePair (pandas pack) suggests RIGHT preferred (bucket 6) on the Koalas task", () => {
  const a = analyzePair(LEFT_TX, RIGHT_TX, PANDAS_PACK);
  assert.equal(a.bucket, 6, `expected bucket 6, got ${a.bucket} (score ${a.score})`);
  // RIGHT's safeguards should surface as LEFT weaknesses…
  const leftCodes = a.weakLeft.map(w => w.code);
  assert.ok(leftCodes.includes("INST"), "LEFT should be flagged for missing length check");
  assert.ok(leftCodes.includes("ROOT"), "LEFT should be flagged for missing index handling");
  // …and RIGHT should not be flagged for laziness on the benign TODO.
  assert.ok(!a.weakRight.some(w => w.code === "LAZY"), "RIGHT must not be flagged LAZY for a design-note TODO");
});

test("analyzePair is orientation-consistent (swapping sides mirrors the bucket)", () => {
  const ab = analyzePair(LEFT_TX, RIGHT_TX, PANDAS_PACK).bucket;
  const ba = analyzePair(RIGHT_TX, LEFT_TX, PANDAS_PACK).bucket;
  assert.equal(ab + ba, 7, "mirrored buckets should sum to 7");
});

/* ════════════════════════════════════════════════════════════════════════
   HARD / ADVERSARIAL example (different domain: a JS debounce race bug).
   Here the SURFACE signals are a trap: the WRONG answer (RIGHT) is flashy —
   edits 3 files, runs tests, claims success — while the CORRECT answer (LEFT)
   is a tiny surgical fix (clear the stale timer) with no fanfare and no tests.
   A naive "more thoroughness = better" engine would pick RIGHT. The point of
   the calibration is that the generic engine must NOT confidently do so.
   ════════════════════════════════════════════════════════════════════════ */
const HARD_LEFT = `
### Tool: bash_exploration_tool
**search_command:** \`grep -n "setTimeout" /src/debounce.js\`

### View \`/src/debounce.js\`
The handle from the previous call is never cleared, so stale callbacks still fire.

### Edit \`/src/debounce.js\`
**With:**
\`\`\`js
function debounce(fn, ms) {
  let prev;
  return (...args) => {
    clearTimeout(prev);
    prev = setTimeout(() => fn(...args), ms);
  };
}
\`\`\`
This clears the stale timer before scheduling a new one.
`;

const HARD_RIGHT = `
### Tool: bash_exploration_tool
**search_command:** \`grep -rn "debounce" /src\`

### View \`/src/debounce.js\`
### View \`/src/handlers.js\`

### Edit \`/src/debounce.js\`
**With:**
\`\`\`js
function debounce(fn, ms) {
  return (...args) => {
    setTimeout(() => {
      try { fn(...args); } catch (e) { /* swallow */ }
    }, ms);
  };
}
\`\`\`

### Edit \`/src/handlers.js\`
### Edit \`/src/index.js\`
Let me run the tests.
All tests pass. This fixes the bug successfully.
`;

test("HARD: generic engine refuses to over-rank a flashy-but-unverified answer", () => {
  const a = analyzePair(HARD_LEFT, HARD_RIGHT); // GENERIC detectors only
  // The raw structure DOES lean toward the thorough (wrong) RIGHT side…
  assert.ok(a.score > 0, "thoroughness pushes the raw score toward RIGHT");
  // …but the engine caps it at a MARGINAL lean (4), never "preferred/strong" (5-7)…
  assert.equal(a.bucket, 4, `expected marginal RIGHT (4), got ${a.bucket}`);
  assert.equal(a.confidence, "low");
  // …and it must loudly warn that thoroughness is not correctness.
  assert.ok(a.cautions.length >= 1, "should emit at least one caution");
  assert.ok(
    a.cautions.some(c => /correctness|thoroughness|verify/i.test(c)),
    "a caution should call out thoroughness-vs-correctness"
  );
});

test("HARD: adding ONE correctness detector flips the verdict to the correct side", () => {
  // The kind of signal a deeper analyzer (or an LLM judge) would supply:
  // does the fix address the ROOT CAUSE (clearing the stale timer)?
  const clearsStaleTimer = {
    id: "clearsStaleTimer",
    label: "Clears stale timer (root cause)",
    tier: "correctness",
    polarity: "good",
    weight: 1.3,
    test: (_p, raw) => /clearTimeout|clears the stale timer/i.test(raw),
  };
  const a = analyzePair(HARD_LEFT, HARD_RIGHT, {
    detectors: [...GENERIC_DETECTORS, clearsStaleTimer],
  });
  assert.ok(a.score < 0, "correctness evidence pulls the score toward LEFT");
  assert.ok(a.bucket !== null && a.bucket <= 3, `expected a LEFT bucket (0-3), got ${a.bucket}`);
  assert.notEqual(a.confidence, "low", "a real correctness signal should raise confidence");
});
