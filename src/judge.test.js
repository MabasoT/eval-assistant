/* ════════════════════════════════════════════════════════════════════════
   judge.test.js — unit tests for the LLM-as-judge core.
   ────────────────────────────────────────────────────────────────────────
   The whole pipeline is exercised with a MOCK model adapter — no network, no
   API key. This is the payoff of dependency injection: we can prove the
   debiasing (position-swap), self-consistency, parsing robustness, and
   calibrated abstention deterministically.
   ════════════════════════════════════════════════════════════════════════ */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildJudgePrompt,
  extractJson,
  parseJudgeResponse,
  toLeftScore,
  leftScoreToBucket,
  aggregateJudgments,
  runJudge,
} from "./judge.js";

/* A correct vs subtly-broken pair. The CORRECT side carries a token the mock
   "competent judge" can recognize — standing in for real semantic judgment. */
const CORRECT = "function unique(a){ return [...new Set(a)]; } // CORRECT_FIX preserves order & dedupes";
const BROKEN  = "function unique(a){ return a.filter((x,i)=>a.indexOf(x)===i+1); } // off-by-one: drops first occurrence";

/** Reads which of A/B contains CORRECT_FIX and scores in that direction.
    Simulates a capable, unbiased judge. */
const competentJudge = async (messages) => {
  const user = messages.find(m => m.role === "user").content;
  const aSection = user.split("=== RESPONSE A ===")[1].split("=== RESPONSE B ===")[0];
  const aIsCorrect = /CORRECT_FIX/.test(aSection);
  const score = aIsCorrect ? 3 : -3;
  return JSON.stringify({
    scoreAvsB: score, confidence: "high",
    criteria: { correctness: score, completeness: 1, instructionFollowing: 1, safety: 0 },
    evidenceA: "a", evidenceB: "b",
    weaknessesA: aIsCorrect ? [] : [{ code: "ROOT", justification: "off-by-one drops first occurrence" }],
    weaknessesB: aIsCorrect ? [{ code: "ROOT", justification: "off-by-one drops first occurrence" }] : [],
    rationale: "The correct side dedupes while preserving order; the other has an off-by-one.",
  });
};

/** A judge with pure POSITION BIAS: always favors whichever is shown as A. */
const positionBiasedJudge = async () => JSON.stringify({
  scoreAvsB: 2.5, confidence: "high",
  criteria: { correctness: 2.5, completeness: 0, instructionFollowing: 0, safety: 0 },
  evidenceA: "", evidenceB: "", weaknessesA: [], weaknessesB: [],
  rationale: "I just like the first one.",
});

/* ───── pure helpers ───── */
test("buildJudgePrompt embeds task, both responses, and key rubric rules", () => {
  const { system, user } = buildJudgePrompt({ task: "dedupe an array", responseA: "AAA", responseB: "BBB" });
  assert.match(system, /CORRECTNESS first/i);
  assert.match(system, /Output ONLY a single JSON object/i);
  assert.match(user, /dedupe an array/);
  assert.match(user, /=== RESPONSE A ===[\s\S]*AAA/);
  assert.match(user, /=== RESPONSE B ===[\s\S]*BBB/);
});

test("extractJson handles fenced + prose-wrapped JSON and ignores braces in strings", () => {
  const wrapped = 'Sure!\n```json\n{"scoreAvsB": 2, "rationale": "uses a map { } here"}\n```\nDone.';
  const obj = extractJson(wrapped);
  assert.equal(obj.scoreAvsB, 2);
  assert.match(obj.rationale, /map/);
});

test("parseJudgeResponse clamps out-of-range scores and defaults bad fields", () => {
  const p = parseJudgeResponse('{"scoreAvsB": 9, "confidence": "bogus", "criteria": {"correctness": -50}}');
  assert.equal(p.scoreAvsB, 3);                 // clamped to range
  assert.equal(p.confidence, "medium");          // invalid -> default
  assert.equal(p.criteria.correctness, -3);      // clamped
  assert.deepEqual(p.weaknessesA, []);
});

test("parseJudgeResponse returns null on garbage", () => {
  assert.equal(parseJudgeResponse("no json here"), null);
});

test("toLeftScore flips sign only for the RL ordering", () => {
  assert.equal(toLeftScore(2, "LR"), 2);
  assert.equal(toLeftScore(2, "RL"), -2);
});

test("leftScoreToBucket bands + mirrors (+ favors LEFT)", () => {
  assert.equal(leftScoreToBucket(0.1), null);   // tie
  assert.equal(leftScoreToBucket(0.5), 3);      // LEFT marginal
  assert.equal(leftScoreToBucket(-0.5), 4);     // RIGHT marginal
  assert.equal(leftScoreToBucket(3), 0);        // LEFT strongest
  assert.equal(leftScoreToBucket(-3), 7);       // RIGHT strongest
});

test("aggregateJudgments lowers confidence on disagreement", () => {
  const agree = aggregateJudgments([2, 2, 2]);
  assert.equal(agree.confidence, "high");
  assert.equal(agree.abstained, false);
  const split = aggregateJudgments([2, -2]);     // perfectly split
  assert.equal(split.abstained, true);
  assert.equal(split.bucket, null);
});

/* ───── the orchestrator: debiasing + correctness ───── */
test("runJudge: a competent judge picks the CORRECT side (LEFT) decisively", async () => {
  const r = await runJudge({ task: "dedupe", leftText: CORRECT, rightText: BROKEN, model: competentJudge });
  assert.ok(r.bucket !== null && r.bucket <= 2, `expected a LEFT bucket (0-2), got ${r.bucket}`);
  assert.equal(r.abstained, false);
  assert.equal(r.confidence, "high");
  // The broken side should accrue the ROOT weakness, the correct side none.
  assert.ok(r.weakRight.some(w => w.code === "ROOT"));
  assert.equal(r.weakLeft.length, 0);
});

test("runJudge: correctness verdict is orientation-independent (swap the inputs)", async () => {
  const r = await runJudge({ task: "dedupe", leftText: BROKEN, rightText: CORRECT, model: competentJudge });
  assert.ok(r.bucket !== null && r.bucket >= 5, `expected a RIGHT bucket (5-7), got ${r.bucket}`);
  assert.ok(r.weakLeft.some(w => w.code === "ROOT")); // broken is now on the LEFT
});

test("KILLER: position-swap NEUTRALIZES a purely position-biased judge -> abstain", async () => {
  const r = await runJudge({ task: "dedupe", leftText: CORRECT, rightText: BROKEN, model: positionBiasedJudge });
  // The biased judge always favors "A"; after swapping orderings the two cancel.
  assert.equal(r.abstained, true, "a pure position bias must collapse to abstain");
  assert.equal(r.bucket, null);
  assert.equal(r.confidence, "low");
  assert.ok(
    r.cautions.some(c => /position bias/i.test(c)),
    "should explicitly report the neutralized position bias"
  );
});

test("runJudge: self-consistency averages multiple noisy samples", async () => {
  let n = 0;
  // Alternates +3 / +2 favoring A (=LEFT here); should average to a strong LEFT lean.
  const noisy = async () => {
    n += 1;
    const score = n % 2 ? 3 : 2;
    return JSON.stringify({ scoreAvsB: score, confidence: "medium", criteria: {}, rationale: "noisy" });
  };
  const r = await runJudge({ task: "x", leftText: CORRECT, rightText: BROKEN, model: noisy, samples: 3, swapPositions: false });
  assert.ok(r.leftScoreMean >= 2, `expected strong LEFT mean, got ${r.leftScoreMean}`);
  assert.ok(r.bucket <= 1, `expected LEFT preferred/strong, got ${r.bucket}`);
  assert.equal(r.samples, 3);
});

test("runJudge: drops unparseable samples and still returns a verdict", async () => {
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n === 1) return "the model rambled with no json";
    return JSON.stringify({ scoreAvsB: -3, confidence: "high", criteria: {}, rationale: "ok" });
  };
  // Both orderings: first call (LR) is garbage, RL call is valid (-3 favors B=LEFT here).
  const r = await runJudge({ task: "x", leftText: BROKEN, rightText: CORRECT, model: flaky });
  assert.ok(r.samples >= 1);
  assert.ok(r.cautions.some(c => /failed to parse/i.test(c)));
});

test("runJudge throws a clear error when no model adapter is supplied", async () => {
  await assert.rejects(() => runJudge({ task: "x", leftText: "a", rightText: "b" }), /model adapter/i);
});
