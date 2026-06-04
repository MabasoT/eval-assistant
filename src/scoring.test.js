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
