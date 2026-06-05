/* ════════════════════════════════════════════════════════════════════════
   judge.js — the LLM-as-judge core of Eval Assistant
   ────────────────────────────────────────────────────────────────────────
   This is the layer that can tell a CORRECT algorithm from a SUBTLY BROKEN
   one — because a regex cannot, only a capable model reading the diff can.

   Design goals (production):
   • Provider-agnostic. The engine never imports a vendor SDK. You inject a
     `model(messages) -> Promise<string>` adapter. Works with Claude, OpenAI,
     Ollama, vLLM, or your own proxy.
   • Debiased. LLM judges have POSITION BIAS (favor whichever side is shown
     first). We run BOTH orderings and average; if they disagree we lower
     confidence / abstain. We also do SELF-CONSISTENCY (N samples) and require
     the model to cite evidence and score each criterion separately.
   • Calibrated. It abstains ("escalate to human") when judges disagree or the
     margin is tiny, instead of guessing.
   • Pure & testable. Every function here is pure or dependency-injected, so the
     whole pipeline is unit-tested with a MOCK model — no network, no API key.

   Scale orientation (shared with scoring.js): 0 = LEFT strongest … 7 = RIGHT.
   Internally the model compares "Response A" vs "Response B" and returns a
   signed score where POSITIVE favors A; we convert to a LEFT-framed score so
   position-swapping is just an averaging step.
   ════════════════════════════════════════════════════════════════════════ */

import { SCALE, suggestBucket, weightedTotal } from "./scoring.js";

/* ───── The evaluation policy the judge must follow ─────
   This distills a rigorous human/AI evaluation process into a reusable rubric.
   It is data — override it per task via opts.rubric. */
export const JUDGE_RUBRIC = `You are a rigorous, impartial senior engineer judging TWO candidate solutions
(Response A and Response B) to the same coding task. Your job is to decide which
solution is better and by how much — and to be RIGHT about subtle correctness.

PRINCIPLES (in priority order):
1. CORRECTNESS first. Does the final code actually solve the task and match the
   reference behavior? Hunt for SUBTLE bugs: off-by-one, wrong index/alignment,
   race conditions, mutation of shared state, edge cases (empty, null, length
   mismatch, unicode, overflow), error handling that hides failures, async/await
   misuse, incorrect complexity. A confident, well-tested WRONG fix is still wrong.
2. A messy path to correct, minimal code beats a clean path to broken code.
   Judge the FINAL code, not the journey (reverts/exploration are fine).
3. Completeness — no TODOs/stubs/half-measures.
4. Instruction-following — did exactly what was asked, no unrequested scope.
5. Safety — no destructive/irreversible actions without cause.
6. Then efficiency, readability, conciseness.

RULES:
- Decide from the ACTUAL code shown. Do not reward verbosity, tool-call count, or
  claims of success ("all tests pass") unless the diff supports them.
- Cite specific evidence (file/line/quote) for every judgment.
- Apply the SAME scrutiny to both sides (symmetry).
- Write the rationale like an experienced human reviewer: first person where natural,
  plain and direct, naming concrete files/methods. No generic praise, no filler.
- If you genuinely cannot tell which is correct from the given material, say so
  with a near-zero score and low confidence — do NOT guess.

Score on a signed scale where POSITIVE favors A and NEGATIVE favors B:
  +3 A clearly correct / B clearly wrong      -3 B clearly correct / A clearly wrong
  +2 A meaningfully better                     -2 B meaningfully better
  +1 A slightly better                         -1 B slightly better
   0 genuine tie / cannot determine

Output ONLY a single JSON object, no prose, no markdown fences:
{
  "scoreAvsB": <number -3..3, positive favors A>,
  "confidence": "low" | "medium" | "high",
  "criteria": {
    "correctness": <number -3..3>,
    "completeness": <number -3..3>,
    "instructionFollowing": <number -3..3>,
    "safety": <number -3..3>
  },
  "evidenceA": "<specific quotes/line refs supporting your read of A>",
  "evidenceB": "<specific quotes/line refs supporting your read of B>",
  "weaknessesA": [{"code": "INST|OVERENG|TOOL|LAZY|VERIFY|FALSE|ROOT|DESTRUCT|FILE|HALLUC|DOCS|VERBOSE", "justification": "<evidence>"}],
  "weaknessesB": [{"code": "...", "justification": "..."}],
  "rationale": "<one tight paragraph naming the decisive difference>"
}`;

/* ───── Prompt construction (pure) ───── */
export function buildJudgePrompt({ task, responseA, responseB, evidence, rubric = JUDGE_RUBRIC }) {
  const system = rubric;
  const user = [
    `TASK / ISSUE:\n${task || "(not provided — infer from the transcripts)"}`,
    evidence ? `\nAUTO-EXTRACTED EVIDENCE (may be incomplete — verify against the code):\n${evidence}` : "",
    `\n=== RESPONSE A ===\n${responseA}`,
    `\n=== RESPONSE B ===\n${responseB}`,
    `\nCompare A vs B per the rubric. Focus on whether each FINAL diff is actually correct. Output ONLY the JSON object.`,
  ].join("\n");
  return { system, user };
}

/* ───── Robust JSON extraction from a model reply (pure) ───── */
export function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  const cleaned = text.replace(/```json/gi, "```").replace(/```/g, "").trim();
  // Fast path: the whole thing is JSON.
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  // Fallback: first balanced {...} block (ignores braces inside strings).
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const numOr = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);

/* ───── Validate & normalize one judge reply (pure) ───── */
export function parseJudgeResponse(text) {
  const obj = extractJson(text);
  if (!obj || !Number.isFinite(Number(obj.scoreAvsB))) return null;
  const crit = obj.criteria || {};
  return {
    scoreAvsB: clamp(numOr(obj.scoreAvsB), -3, 3),
    confidence: ["low", "medium", "high"].includes(obj.confidence) ? obj.confidence : "medium",
    criteria: {
      correctness: clamp(numOr(crit.correctness), -3, 3),
      completeness: clamp(numOr(crit.completeness), -3, 3),
      instructionFollowing: clamp(numOr(crit.instructionFollowing), -3, 3),
      safety: clamp(numOr(crit.safety), -3, 3),
    },
    evidenceA: String(obj.evidenceA || ""),
    evidenceB: String(obj.evidenceB || ""),
    weaknessesA: Array.isArray(obj.weaknessesA) ? obj.weaknessesA : [],
    weaknessesB: Array.isArray(obj.weaknessesB) ? obj.weaknessesB : [],
    rationale: String(obj.rationale || ""),
  };
}

/* ───── Frame conversion: A-vs-B score -> LEFT-framed score ─────
   ordering "LR" means A=LEFT (so +score favors LEFT).
   ordering "RL" means A=RIGHT (so +score favors RIGHT => negate for LEFT frame). */
export function toLeftScore(scoreAvsB, ordering) {
  return ordering === "LR" ? scoreAvsB : -scoreAvsB;
}

/* ───── Map a LEFT-framed mean (-3..3, + favors LEFT) to a 0–7 bucket (pure) ───── */
export function leftScoreToBucket(mean) {
  const mag = Math.abs(mean);
  if (mag < 0.25) return null; // genuine tie / abstain
  let level;
  if (mag >= 2.5) level = 3;       // strong
  else if (mag >= 1.5) level = 2;  // preferred
  else if (mag >= 0.75) level = 1; // slightly
  else level = 0;                  // marginal
  return mean > 0 ? [3, 2, 1, 0][level] : [4, 5, 6, 7][level];
}

const confRank = c => ({ low: 0, medium: 1, high: 2 }[c] ?? 1);
const downgrade = c => (["low", "medium", "high"][Math.max(0, confRank(c) - 1)]);

/* ───── Aggregate many LEFT-framed scores into a calibrated verdict (pure) ─────
   Confidence tracks BOTH the margin and the agreement across samples/orderings. */
export function aggregateJudgments(leftScores) {
  const n = leftScores.length;
  if (n === 0) return { mean: 0, stdev: 0, agreement: 0, bucket: null, confidence: "low", abstained: true };
  const mean = leftScores.reduce((a, b) => a + b, 0) / n;
  const variance = leftScores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const pos = leftScores.filter(s => s > 0).length;
  const neg = leftScores.filter(s => s < 0).length;
  const agreement = Math.max(pos, neg) / n; // share sharing the majority sign

  let bucket = leftScoreToBucket(mean);
  let confidence = Math.abs(mean) >= 2 ? "high" : Math.abs(mean) >= 1 ? "medium" : "low";
  if (n > 1 && (agreement < 0.7 || stdev > 1.2)) confidence = downgrade(confidence);

  // Abstain when it's a tie, or judges materially disagree without a clear mean.
  const abstained = bucket === null || (n > 1 && agreement < 0.6 && Math.abs(mean) < 1);
  if (abstained) confidence = "low";

  return {
    mean: +mean.toFixed(3),
    stdev: +stdev.toFixed(3),
    agreement: +agreement.toFixed(2),
    bucket,
    confidence,
    abstained,
  };
}

/* ───── Orchestrator: run the judge with debiasing + self-consistency ─────
   `model` is an injected async fn: (messages:[{role,content}]) => Promise<string>.
   Returns a calibrated verdict with evidence, per-criterion scores, and cautions.
   Pure w.r.t. the model: same model -> same result. Network lives in the adapter. */
export async function runJudge({
  task, leftText, rightText, evidence, rubric,
  model, samples = 1, swapPositions = true,
}) {
  if (typeof model !== "function") throw new Error("runJudge requires a model adapter: (messages) => Promise<string>");
  const orderings = swapPositions ? ["LR", "RL"] : ["LR"];
  const judgments = [];

  for (const ordering of orderings) {
    const A = ordering === "LR" ? leftText : rightText;
    const B = ordering === "LR" ? rightText : leftText;
    const { system, user } = buildJudgePrompt({ task, responseA: A, responseB: B, evidence, rubric });
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    for (let s = 0; s < samples; s++) {
      try {
        const text = await model(messages);
        const j = parseJudgeResponse(text);
        judgments.push(j ? { ordering, j } : { ordering, error: "unparseable" });
      } catch (e) {
        judgments.push({ ordering, error: String((e && e.message) || e) });
      }
    }
  }

  const valid = judgments.filter(x => x.j);
  if (valid.length === 0) {
    return {
      bucket: null, confidence: "low", abstained: true,
      leftScoreMean: 0, agreement: 0, perCriterion: {},
      weakLeft: [], weakRight: [], rationale: "",
      cautions: ["The model returned no parseable verdicts — check the adapter/model."],
      raw: judgments,
    };
  }

  const leftScores = valid.map(x => toLeftScore(x.j.scoreAvsB, x.ordering));
  const agg = aggregateJudgments(leftScores);

  // Per-criterion, averaged and LEFT-framed.
  const critKeys = ["correctness", "completeness", "instructionFollowing", "safety"];
  const perCriterion = {};
  for (const k of critKeys) {
    const vals = valid.map(x => toLeftScore(x.j.criteria[k], x.ordering));
    perCriterion[k] = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  }

  // Weaknesses, framed to LEFT/RIGHT per ordering, de-duplicated.
  const weakLeft = [], weakRight = [];
  for (const { ordering, j } of valid) {
    const aIsLeft = ordering === "LR";
    (j.weaknessesA || []).forEach(w => (aIsLeft ? weakLeft : weakRight).push(w));
    (j.weaknessesB || []).forEach(w => (aIsLeft ? weakRight : weakLeft).push(w));
  }
  const dedupe = arr => {
    const seen = new Set();
    return arr.filter(w => {
      const key = `${w && w.code}|${String((w && w.justification) || "").slice(0, 40)}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  };

  const cautions = [];
  if (agg.abstained) cautions.push("Verdict is too close or the judges disagreed — escalate to human review.");
  if (swapPositions) {
    const lr = valid.filter(x => x.ordering === "LR").map(x => toLeftScore(x.j.scoreAvsB, "LR"));
    const rl = valid.filter(x => x.ordering === "RL").map(x => toLeftScore(x.j.scoreAvsB, "RL"));
    if (lr.length && rl.length) {
      const mlr = lr.reduce((a, b) => a + b, 0) / lr.length;
      const mrl = rl.reduce((a, b) => a + b, 0) / rl.length;
      if (Math.sign(mlr) !== Math.sign(mrl) && Math.abs(mlr) > 0.5 && Math.abs(mrl) > 0.5) {
        cautions.push("Position bias detected: the two orderings disagreed. The position-swap neutralized it and lowered confidence — treat as a coin-flip and review manually.");
      }
    }
  }
  const errCount = judgments.filter(x => x.error).length;
  if (errCount > 0) cautions.push(`${errCount} sample(s) failed to parse/return and were dropped.`);

  // Rationale: take the highest-confidence valid judgment's paragraph.
  const best = valid.slice().sort((a, b) => confRank(b.j.confidence) - confRank(a.j.confidence))[0];

  return {
    bucket: agg.bucket,
    confidence: agg.confidence,
    abstained: agg.abstained,
    suggestedLabel: agg.bucket === null ? "Too close to call — human review" : SCALE[agg.bucket].label,
    leftScoreMean: agg.mean,
    stdev: agg.stdev,
    agreement: agg.agreement,
    perCriterion,
    weakLeft: dedupe(weakLeft),
    weakRight: dedupe(weakRight),
    rationale: best.j.rationale || "",
    cautions,
    samples: valid.length,
    raw: judgments,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   FULL-FORM AUTO-DRAFT — fills the entire evaluation, ready to approve
   ────────────────────────────────────────────────────────────────────────
   runDraft() asks the model to produce every field of the form (strengths,
   weaknesses with justification + evidence, and a 1–5 score per worksheet
   dimension for each side). The Overall Preference is then DERIVED from the
   worksheet via suggestBucket() — so the suggested rating can never disagree
   with the worksheet, and the number is less position-sensitive than asking the
   model for a holistic A-vs-B score. You review the draft and click to apply.
   ════════════════════════════════════════════════════════════════════════ */

export function buildDraftPrompt({ task, responseA, responseB, dimensions, taxonomy }) {
  const taxList = (taxonomy || []).map(t => `${t.code}: ${t.desc}`).join("\n");
  const wsSchema = (dimensions || []).map(d => `"${d.key}": {"a": <1-5>, "b": <1-5>}`).join(", ");
  const wsLegend = (dimensions || []).map(d => `${d.key} = ${d.label} (${d.desc})`).join("; ");
  const system = `You are a rigorous, impartial code-evaluation judge. Read BOTH responses and draft a COMPLETE evaluation form.
Judge CORRECTNESS of the FINAL code first — hunt subtle bugs (off-by-one, wrong index/alignment, races, edge cases, error-swallowing). A confident, well-tested WRONG fix is still wrong. Judge the final code, not the journey. Cite specific evidence. Apply the same scrutiny to both sides.

VOICE — write like an EXPERIENCED HUMAN REVIEWER, not an AI:
- First person where natural ("A goes straight for the error string", "I'm not flagging the TODO", "based on what I see").
- Plain, direct sentences; vary the rhythm; a little blunt is fine. Sound like a senior engineer talking, not a press release.
- Always name concrete things: file names, method names (e.g. _assign / __setitem__), line refs, function/arg names, the actual code.
- NO generic praise ("elegant", "demonstrates deep understanding", "best practices"), NO marketing words, NO filler, NO hedging.
  GOOD: "A used grep to find the error in frame.py, read _assign and __setitem__, then made one scoped edit."
  BAD:  "The model did a great job solving the problem efficiently and elegantly."

Worksheet dimensions to score 1 (poor) … 5 (excellent), per side: ${wsLegend}

Taxonomy codes (use ONLY these for weaknesses):
${taxList}

Output ONLY one JSON object, no markdown, no prose:
{
  "strengthA": "<at least 200 characters; specific files/tool calls/code/why it is correct>",
  "strengthB": "<at least 200 characters>",
  "weaknessesA": [{"code": "<one taxonomy code>", "justification": "<>=20 chars, why it is wrong and why it matters>", "evidence": "<exact quote or line ref from the transcript, >=20 chars>"}],
  "weaknessesB": [ ... same shape ... ],
  "worksheet": { ${wsSchema} },
  "rationale": "<one paragraph, >=50 chars, naming the decisive difference; must agree with whichever side your worksheet scores higher>"
}
Only list weaknesses you can back with evidence; if a side has none use []. Fill EVERY worksheet dimension for both a and b.`;
  const user = `TASK / ISSUE:\n${task || "(infer from the transcripts)"}\n\n=== RESPONSE A ===\n${responseA}\n\n=== RESPONSE B ===\n${responseB}\n\nDraft the full evaluation JSON now.`;
  return { system, user };
}

const clampScore = x => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 3; };

export function parseDraftResponse(text, { dimensions, taxonomy }) {
  const obj = extractJson(text);
  if (!obj) return null;
  const codes = new Set((taxonomy || []).map(t => t.code));
  const cleanWeak = arr => (Array.isArray(arr) ? arr : [])
    .filter(w => w && codes.has(w.code))
    .map(w => ({ code: w.code, justification: String(w.justification || ""), evidence: String(w.evidence || "") }));
  const wsAB = {};
  for (const dim of (dimensions || [])) {
    const cell = (obj.worksheet && obj.worksheet[dim.key]) || {};
    wsAB[dim.key] = {
      a: clampScore(cell.a ?? cell.left ?? cell.A ?? cell.L),
      b: clampScore(cell.b ?? cell.right ?? cell.B ?? cell.R),
    };
  }
  return {
    strengthA: String(obj.strengthA || ""),
    strengthB: String(obj.strengthB || ""),
    weakA: cleanWeak(obj.weaknessesA),
    weakB: cleanWeak(obj.weaknessesB),
    wsAB,
    rationale: String(obj.rationale || ""),
  };
}

function averageWorksheets(list, dimensions) {
  const out = {};
  const avg = a => (a.length ? Math.max(1, Math.min(5, Math.round(a.reduce((x, y) => x + y, 0) / a.length))) : 3);
  for (const dim of dimensions) {
    const Ls = list.map(w => w[dim.key]?.L).filter(v => typeof v === "number");
    const Rs = list.map(w => w[dim.key]?.R).filter(v => typeof v === "number");
    out[dim.key] = { L: avg(Ls), R: avg(Rs) };
  }
  return out;
}

export async function runDraft({ task, leftText, rightText, model, dimensions, taxonomy, samples = 1, swapPositions = true }) {
  if (typeof model !== "function") throw new Error("runDraft requires a model adapter: (messages) => Promise<string>");
  const orderings = swapPositions ? ["LR", "RL"] : ["LR"];
  const collected = [];
  for (const ordering of orderings) {
    const A = ordering === "LR" ? leftText : rightText;
    const B = ordering === "LR" ? rightText : leftText;
    const { system, user } = buildDraftPrompt({ task, responseA: A, responseB: B, dimensions, taxonomy });
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    for (let s = 0; s < samples; s++) {
      try {
        const text = await model(messages);
        const d = parseDraftResponse(text, { dimensions, taxonomy });
        if (d) collected.push({ ordering, d });
      } catch { /* skip this sample */ }
    }
  }
  if (collected.length === 0) return null;

  // Frame every worksheet to LEFT/RIGHT, then average (debiases the numbers).
  const framedWs = collected.map(({ ordering, d }) => {
    const ws = {};
    for (const dim of dimensions) {
      const cell = d.wsAB[dim.key] || { a: 3, b: 3 };
      ws[dim.key] = ordering === "LR" ? { L: cell.a, R: cell.b } : { L: cell.b, R: cell.a };
    }
    return ws;
  });
  const worksheet = averageWorksheets(framedWs, dimensions);

  // Text fields from an LR draft (A=LEFT) so the wording is correctly framed.
  const lr = collected.find(x => x.ordering === "LR") || collected[0];
  const isLR = lr.ordering === "LR";
  const d = lr.d;
  const strengthLeft = isLR ? d.strengthA : d.strengthB;
  const strengthRight = isLR ? d.strengthB : d.strengthA;
  const weakLeft = isLR ? d.weakA : d.weakB;
  const weakRight = isLR ? d.weakB : d.weakA;

  const leftTotal = weightedTotal(worksheet, "L", dimensions);
  const rightTotal = weightedTotal(worksheet, "R", dimensions);
  const { bucket } = suggestBucket(leftTotal, rightTotal);

  return {
    strengthLeft, strengthRight, weakLeft, weakRight,
    worksheet,
    preference: bucket,                          // derived from the worksheet
    preferenceLabel: bucket === null ? "Tie — pick 3 or 4 manually" : SCALE[bucket].label,
    rationale: d.rationale,
    leftTotal, rightTotal,
    samples: collected.length,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   Provider adapters (thin, optional, NOT unit-tested — they touch the network)
   ────────────────────────────────────────────────────────────────────────
   An adapter is just `(messages) => Promise<string>`. Keys/endpoints are
   supplied at RUNTIME by the user and never stored in the repo.
   ════════════════════════════════════════════════════════════════════════ */

/** OpenAI-compatible chat endpoint (works with OpenAI, Ollama, vLLM, LM Studio,
    most proxies). For Ollama use endpoint "http://localhost:11434/v1/chat/completions". */
export function openAiCompatibleAdapter({ endpoint, apiKey, model, temperature = 0.2, fetchImpl, extraHeaders }) {
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch implementation available");
  return async (messages) => {
    // NB: we deliberately do NOT send `response_format` — many providers (incl.
    // Anthropic models via OpenRouter) reject it. The prompt forces JSON and
    // extractJson() tolerates fences/prose, so this is the most compatible path.
    const res = await f(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(extraHeaders || {}) },
      body: JSON.stringify({ model, messages, temperature }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`Model HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? "";
  };
}

/** Anthropic Messages API adapter. NOTE: calling this directly from a browser
    exposes your key and is blocked by CORS — use it from a server/proxy. */
export function anthropicAdapter({ apiKey, model = "claude-sonnet-4-20250514", maxTokens = 1500, baseUrl = "https://api.anthropic.com/v1/messages", temperature = 0.2, fetchImpl }) {
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch implementation available");
  return async (messages) => {
    const system = messages.find(m => m.role === "system")?.content || "";
    const rest = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
    const res = await f(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: rest }),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
    const data = await res.json();
    return (data?.content || []).map(b => b.text || "").join("");
  };
}
