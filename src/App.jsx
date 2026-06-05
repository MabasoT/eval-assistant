import { useState, useEffect, useRef } from "react";
import {
  SCALE,
  DEFAULT_TAXONOMY,
  DEFAULT_DIMENSIONS,
  blankWorksheet,
  weightedTotal,
  worksheetComplete,
  suggestBucket,
  maxWeighted,
  totalWeight,
  parseTranscript,
  analyzePair,
} from "./scoring.js";
import { runJudge, runDraft, openAiCompatibleAdapter } from "./judge.js";

/* ════════════════════════════════════════════════════════════════════════
   EVAL ASSISTANT — LEFT vs RIGHT response evaluation workbench
   ────────────────────────────────────────────────────────────────────────
   This tool mirrors the Labelbox pairwise-evaluation form 1:1:
     • Each response (LEFT and RIGHT) has a "Classifications" block:
         - Strengths of Response (free text, char-counted)
         - Identify issues (12 checkbox codes, each with justification + evidence)
     • ONE shared Overall Preference on a 0–7 scale (0 = LEFT, 7 = RIGHT)
     • ONE shared Rationale (>= 50 chars)

   Design philosophy: the tool STRUCTURES judgment and CATCHES inconsistencies.
   It never writes your answers, never auto-submits, and makes no network/AI
   calls. Every suggestion is advisory and must be confirmed by you.
   ════════════════════════════════════════════════════════════════════════ */

/* ───── Tunable constants (change minimums in ONE place) ───── */
const MIN_STRENGTH_CHARS = 50;        // per-response "Strengths" minimum (not confirmed — adjust here)
const MIN_ISSUE_EVIDENCE_CHARS = 20;  // per-issue transcript evidence minimum
const MIN_ISSUE_JUSTIFY_CHARS = 20;   // per-issue justification minimum
const MIN_RATIONALE_CHARS = 50;       // shared rationale minimum (confirmed by the form)

/* SCALE, the default taxonomy/dimensions, and the pure scoring helpers
   (blankWorksheet, weightedTotal, worksheetComplete, suggestBucket, …) live in
   ./scoring.js so they can be unit-tested in isolation. See scoring.test.js. */

/* parseTranscript() + analyzePair() (the evidence engine) live in ./scoring.js
   so they are pure and unit-tested (see scoring.test.js). The parser is a
   READING AID and the suggestion is ADVISORY — neither auto-fills your answers. */

/* ───── Snippets for quick-fill (manual aids — you still write the substance) ───── */
const STRENGTH_SNIPPETS = [
  "Model used grep/search to locate the relevant code before editing, showing good codebase navigation. ",
  "Model read the existing implementation to understand context before making changes. ",
  "Model's final code correctly handles the reported issue by ",
  "Model checked imports and dependencies before modifying the function. ",
  "Model ran tests/verification after making changes to confirm the fix. ",
  "Model took a methodical approach: read -> understand -> edit -> verify. ",
  "Model correctly identified the root cause in [FILE] and targeted the fix precisely. ",
  "No unnecessary files were created or modified -- changes were scoped to the task. ",
  "Model handled edge cases by ",
  "Model's solution maintains backward compatibility by ",
];

const WEAKNESS_SNIPPETS = {
  INST: "Model ignored the requirement to [X] as stated in the prompt. The prompt explicitly says [Y] but model did [Z] instead.",
  OVERENG: "Model added [FEATURE] which was not requested. The prompt only asks for [X] but model also implemented [Y].",
  TOOL: "Model used [TOOL] incorrectly when calling [FUNCTION]. The correct usage is [X] but model passed [Y].",
  LAZY: "Model left a TODO/placeholder at [FILE:LINE]: '[TEXT]'. The final code is incomplete.",
  VERIFY: "Model claims '[CLAIM]' but did not run tests or verify the output. No evidence of checking correctness.",
  FALSE: "Model states '[CLAIM]' but the tool output shows [ACTUAL_RESULT]. The fix does not work as claimed.",
  ROOT: "Model patches the symptom by [FIX] but the root cause is [ACTUAL_ISSUE]. The error will recur when [SCENARIO].",
  DESTRUCT: "Model runs [COMMAND] which could [CONSEQUENCE] without warning or confirmation.",
  FILE: "Model edits [WRONG_FILE] but the issue is in [CORRECT_FILE]. / Model creates [FILE] which is unnecessary.",
  HALLUC: "Model references [FUNCTION/API] in [FILE] but this does not exist in the codebase. Only [ACTUAL] exists.",
  DOCS: "Model adds documentation/comments that were not requested and add noise to the diff.",
  VERBOSE: "Model includes excessive explanation/markdown formatting. The response could be significantly shorter.",
};

/* ───── Persistence hooks ───── */
function usePersist(key, initial) {
  const [state, setState] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; }
    catch { return initial; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(state)); }, [key, state]);
  return [state, setState];
}

function useHistory() {
  const [history, setHistory] = usePersist("eval-history", []);
  const save = (entry) => setHistory(prev => [{ ...entry, savedAt: new Date().toISOString() }, ...prev].slice(0, 50));
  const remove = (idx) => setHistory(prev => prev.filter((_, i) => i !== idx));
  return { history, save, remove };
}

/* ───── Presentational components ───── */
function Badge({ text, color = "#4a6fa5", bg = "rgba(74,111,165,0.08)" }) {
  return <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, fontFamily: "var(--mono)", background: bg, color, whiteSpace: "nowrap" }}>{text}</span>;
}

function CharBadge({ len, min }) {
  const ok = len >= min;
  return <Badge text={`${len}/${min} ${ok ? "✓" : "✗"}`} color={ok ? "#1a7a3a" : "#c44"} bg={ok ? "#e8f5ee" : "#fef2f0"} />;
}

function Btn({ children, onClick, primary, small, danger, disabled, style: s = {} }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{
      padding: small ? "4px 10px" : "8px 16px",
      borderRadius: 7, border: "none", cursor: disabled ? "not-allowed" : "pointer",
      fontSize: small ? 11 : 13, fontWeight: 600,
      background: danger ? "#c44" : primary ? "#4a6fa5" : "#f0f1f3",
      color: (primary || danger) ? "#fff" : "#4a5568",
      opacity: disabled ? 0.5 : 1, transition: "all 0.12s", ...s,
    }}>{children}</button>
  );
}

function Card({ title, tag, children, right }) {
  return (
    <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e8eaed", marginBottom: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid #f0f1f3", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {tag && <span style={{ padding: "2px 8px", borderRadius: 6, background: "#4a6fa5", color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)" }}>{tag}</span>}
          <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
        </div>
        {right}
      </div>
      <div style={{ padding: "12px 16px" }}>{children}</div>
    </div>
  );
}

function ParsedView({ parsed }) {
  if (!parsed) return <p style={{ fontSize: 12, color: "#9ca3af", padding: 10 }}>Paste a transcript to see analysis (reading aid only)</p>;
  return (
    <div style={{ fontSize: 12, fontFamily: "var(--mono)", lineHeight: 1.8, color: "#4a5568" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <Badge text={`${parsed.toolCallCount} tool calls`} />
        <Badge text={`${parsed.editOps} edit ops`} color="#8a5a1a" bg="#fef8e8" />
        <Badge text={`${parsed.filesEdited.length} files edited`} color="#8a5a1a" bg="#fef8e8" />
        <Badge text={`${parsed.lineCount} lines`} color="#5a5a8a" bg="#f0f0fa" />
        {parsed.hasLengthCheck && <Badge text="length-check ✓" color="#1a7a3a" bg="#e8f5ee" />}
        {parsed.hasIndexHandling && <Badge text="index-handling ✓" color="#1a7a3a" bg="#e8f5ee" />}
        {parsed.reverts.length > 0 && <Badge text={`${parsed.reverts.length} self-corrections`} color="#8a6a10" bg="#fef8e8" />}
        {parsed.placeholderTodos.length > 0 && <Badge text={`${parsed.placeholderTodos.length} placeholders !`} color="#c44" bg="#fef2f0" />}
        {parsed.successClaims.length > 0 && <Badge text={`${parsed.successClaims.length} success claims`} color="#8a6a10" bg="#fef8e8" />}
        {parsed.errors.length > 0 && <Badge text={`${parsed.errors.length} errors`} color="#c44" bg="#fef2f0" />}
      </div>
      {parsed.filesEdited.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <strong style={{ color: "#1a1a2e" }}>Files edited:</strong>
          {parsed.filesEdited.map((f, i) => <div key={i} style={{ paddingLeft: 12, color: "#c44" }}>* {f}</div>)}
        </div>
      )}
      {parsed.filesRead.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <strong style={{ color: "#1a1a2e" }}>Files read:</strong>
          {parsed.filesRead.map((f, i) => <div key={i} style={{ paddingLeft: 12 }}>* {f}</div>)}
        </div>
      )}
      {parsed.commands.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <strong style={{ color: "#1a1a2e" }}>Commands:</strong>
          {parsed.commands.map((c, i) => <div key={i} style={{ paddingLeft: 12, fontSize: 11 }}>$ {c}</div>)}
        </div>
      )}
      {parsed.todos.length > 0 && (
        <div style={{ marginBottom: 8, padding: 8, background: "#fef2f0", borderRadius: 6 }}>
          <strong style={{ color: "#c44" }}>TODOs/Placeholders:</strong>
          {parsed.todos.map((t, i) => <div key={i} style={{ paddingLeft: 12, fontSize: 11 }}>L{t.line}: {t.text}</div>)}
        </div>
      )}
    </div>
  );
}

/* ───── Evidence-based suggestion (ADVISORY — opt-in, never auto-fills) ─────
   Wraps analyzePair() from the engine. Shows a suggested 0–7 bucket from
   OBSERVABLE structure (validation, index handling, stubs, churn, errors),
   plus the per-side draft weaknesses and key differences. You confirm or
   override everything in the worksheet — this never writes your answers. */
function SuggestionCard({ left, right }) {
  const [shown, setShown] = useState(false);
  const ready = left.trim() && right.trim();
  const a = shown && ready ? analyzePair(left, right) : null;
  return (
    <Card tag="HINT" title="Evidence-based suggestion (advisory)" right={
      <Btn small onClick={() => setShown(s => !s)} disabled={!ready}>{shown ? "Hide" : ready ? "Show suggestion" : "Paste both first"}</Btn>
    }>
      {!shown ? (
        <p style={{ fontSize: 11.5, color: "#6b7280", margin: 0 }}>
          Compares LEFT vs RIGHT on signals a parser can actually see — input/length validation, index handling, placeholder stubs, self-correction churn, runtime errors — and proposes a bucket. It cannot judge semantic correctness; confirm in the worksheet.
        </p>
      ) : a ? (
        <div style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.6 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Suggested:</strong>{" "}
            {a.bucket === null
              ? <Badge text="Too close to call" color="#8a6a10" bg="#fef8e8" />
              : <Badge text={`${a.bucket} — ${SCALE[a.bucket].label}`} color={SCALE[a.bucket].c} bg="#f4f5f7" />}
            <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af" }}>confidence: {a.confidence} (score {a.score.toFixed(2)})</span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>Key differences:</strong>
            {a.keyDifferences.map((d, i) => <div key={i} style={{ paddingLeft: 10, fontFamily: "var(--mono)", fontSize: 11 }}>* {d}</div>)}
          </div>
          {(a.weakLeft.length > 0 || a.weakRight.length > 0) && (
            <div style={{ marginBottom: 8 }}>
              <strong>Draft issues to verify:</strong>
              {a.weakLeft.map((w, i) => <div key={"l" + i} style={{ paddingLeft: 10, fontSize: 11 }}><code style={{ color: "#993333" }}>{w.code}</code> (LEFT) {w.justification}</div>)}
              {a.weakRight.map((w, i) => <div key={"r" + i} style={{ paddingLeft: 10, fontSize: 11 }}><code style={{ color: "#993333" }}>{w.code}</code> (RIGHT) {w.justification}</div>)}
            </div>
          )}
          {a.cautions && a.cautions.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {a.cautions.map((c, i) => (
                <div key={i} style={{ padding: 8, marginBottom: 4, background: "#fdf0f0", border: "1px solid #f5d5d0", borderRadius: 6, fontSize: 11, color: "#993333" }}>{"⚠"} {c}</div>
              ))}
            </div>
          )}
          <div style={{ padding: 8, background: "#fef8e8", borderRadius: 6, fontSize: 11 }}>{"💡"} {a.note}</div>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Paste both transcripts on the Paste step first.</p>
      )}
    </Card>
  );
}

/* ───── AI Judge (LLM-as-judge) — bring your own model endpoint ─────
   This is the layer that can tell a correct algorithm from a subtly broken one.
   It is OFF by default and never auto-fills the form. It runs the position-swap
   + self-consistency engine in judge.js against ANY OpenAI-compatible endpoint
   (Ollama at localhost works from the browser; hosted models need your own proxy
   because of CORS / key safety). Your key is held in memory only — never stored. */
function JudgePanel({ task, left, right, evidence, dimensions, taxonomy, onApply }) {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = usePersist("eval-judge-endpoint", "https://openrouter.ai/api/v1/chat/completions");
  const [model, setModel] = usePersist("eval-judge-model", "anthropic/claude-3.5-sonnet");
  const [apiKey, setApiKey] = usePersist("eval-judge-key", ""); // persisted for convenience — see warning + Clear
  const [samples, setSamples] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [res, setRes] = useState(null);      // correctness verdict (runJudge)
  const [draft, setDraft] = useState(null);  // full-form draft (runDraft)

  const ready = left.trim() && right.trim() && endpoint.trim() && model.trim();
  const adapter = () => openAiCompatibleAdapter({ endpoint, apiKey: apiKey || undefined, model });

  const runAutoDraft = async () => {
    setBusy("draft"); setErr(null); setDraft(null); setRes(null);
    try {
      const d = await runDraft({ task, leftText: left, rightText: right, model: adapter(), dimensions, taxonomy, samples, swapPositions: true });
      if (!d) setErr("The model returned nothing usable. Try another model or check the key/endpoint.");
      else setDraft(d);
    } catch (e) { setErr(String((e && e.message) || e)); }
    finally { setBusy(false); }
  };

  const runVerdict = async () => {
    setBusy("judge"); setErr(null); setRes(null); setDraft(null);
    try {
      const r = await runJudge({ task, leftText: left, rightText: right, evidence, model: adapter(), samples, swapPositions: true });
      setRes(r);
    } catch (e) { setErr(String((e && e.message) || e)); }
    finally { setBusy(false); }
  };

  const inp = { padding: "5px 8px", borderRadius: 6, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", background: "#fafbfc", boxSizing: "border-box" };

  return (
    <Card tag="AI ASSIST" title="AI auto-draft + judge (your model)" right={
      <Btn small onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Set up"}</Btn>
    }>
      {!open ? (
        <p style={{ fontSize: 11.5, color: "#6b7280", margin: 0 }}>
          Let a real model <strong>fill the whole form for you</strong> — strengths, weaknesses, the 1–5 worksheet, and a suggested 0–7 preference — then you review and approve. Or run just the debiased correctness verdict. Bring your own model (OpenRouter works from the browser).
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label style={{ fontSize: 10, color: "#6b7280" }}>Endpoint (OpenAI-compatible)
              <input value={endpoint} onChange={e => setEndpoint(e.target.value)} style={{ ...inp, width: "100%" }} />
            </label>
            <label style={{ fontSize: 10, color: "#6b7280" }}>Model (e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o-mini)
              <input value={model} onChange={e => setModel(e.target.value)} style={{ ...inp, width: "100%" }} />
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 6, alignItems: "end" }}>
            <label style={{ fontSize: 10, color: "#6b7280" }}>API key (OpenRouter sk-or-…)
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="paste your key" style={{ ...inp, width: "100%" }} />
            </label>
            <label style={{ fontSize: 10, color: "#6b7280" }}>Samples
              <input type="number" min={1} max={5} value={samples} onChange={e => setSamples(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} style={{ ...inp, width: "100%" }} />
            </label>
            <Btn small onClick={() => setApiKey("")}>Clear key</Btn>
          </div>
          <div style={{ padding: 7, background: "#fef8e8", border: "1px solid #f0e0a8", borderRadius: 6, fontSize: 10, color: "#8a6a10" }}>
            {"⚠"} The key is stored in this browser (localStorage) for convenience. Don't use this on a shared computer, and rotate the key if it has ever been pasted somewhere public. Use "Clear key" when done.
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            <Btn primary disabled={!ready || busy} onClick={runAutoDraft} style={{ flex: 2 }}>
              {busy === "draft" ? "Drafting…" : ready ? "✨ Auto-draft the whole form" : "Paste transcripts + set key"}
            </Btn>
            <Btn disabled={!ready || busy} onClick={runVerdict} style={{ flex: 1 }}>
              {busy === "judge" ? "Judging…" : "Verdict only"}
            </Btn>
          </div>
          <p style={{ fontSize: 10, color: "#9ca3af", margin: 0 }}>
            Both run the comparison in BOTH orderings to cancel position bias. The draft never auto-submits — you click <strong>Apply</strong>, then review every tab.
          </p>

          {err && <div style={{ padding: 8, background: "#fef2f0", border: "1px solid #f5d5d0", borderRadius: 6, fontSize: 11, color: "#c44" }}>{"⚠"} {err}</div>}

          {draft && (
            <div style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.6, marginTop: 4, padding: 10, background: "#f6f7f9", border: "1px solid #e8eaed", borderRadius: 8 }}>
              <div style={{ marginBottom: 6 }}>
                <strong>Suggested preference:</strong>{" "}
                {draft.preference === null
                  ? <Badge text="Tie — pick 3 or 4" color="#8a6a10" bg="#fef8e8" />
                  : <Badge text={`${draft.preference} — ${SCALE[draft.preference].label}`} color={SCALE[draft.preference].c} bg="#fff" />}
                <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af" }}>worksheet LEFT {draft.leftTotal} vs RIGHT {draft.rightTotal} · n={draft.samples}</span>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, marginBottom: 6 }}>
                {dimensions.map(dm => (
                  <span key={dm.key} style={{ marginRight: 10 }}>{dm.label}: <strong style={{ color: "#1a8a45" }}>{draft.worksheet[dm.key]?.L}</strong>/<strong style={{ color: "#993333" }}>{draft.worksheet[dm.key]?.R}</strong></span>
                ))}
              </div>
              <div style={{ marginBottom: 4 }}><strong>LEFT strengths:</strong> {draft.strengthLeft.slice(0, 140)}… <span style={{ color: "#9ca3af" }}>({draft.strengthLeft.length} chars)</span></div>
              <div style={{ marginBottom: 4 }}><strong>RIGHT strengths:</strong> {draft.strengthRight.slice(0, 140)}… <span style={{ color: "#9ca3af" }}>({draft.strengthRight.length} chars)</span></div>
              {draft.weakLeft.map((w, i) => <div key={"l" + i} style={{ fontSize: 11 }}><code style={{ color: "#993333" }}>{w.code}</code> (LEFT) {w.justification}</div>)}
              {draft.weakRight.map((w, i) => <div key={"r" + i} style={{ fontSize: 11 }}><code style={{ color: "#993333" }}>{w.code}</code> (RIGHT) {w.justification}</div>)}
              {draft.rationale && <div style={{ marginTop: 4 }}><strong>Rationale:</strong> {draft.rationale}</div>}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <Btn primary onClick={() => onApply(draft)} style={{ flex: 1 }}>Apply to form → review & validate</Btn>
                <Btn onClick={() => setDraft(null)}>Discard</Btn>
              </div>
              <p style={{ fontSize: 10, color: "#9ca3af", margin: "6px 0 0" }}>
                After applying, walk LEFT → RIGHT → Preference → Submit. Edit anything you disagree with; the Submit step will confirm character minimums.
              </p>
            </div>
          )}

          {res && (
            <div style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.6, marginTop: 4 }}>
              <div style={{ marginBottom: 6 }}>
                <strong>Verdict:</strong>{" "}
                {res.bucket === null
                  ? <Badge text="Abstain — human review" color="#8a6a10" bg="#fef8e8" />
                  : <Badge text={`${res.bucket} — ${SCALE[res.bucket].label}`} color={SCALE[res.bucket].c} bg="#f4f5f7" />}
                <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af" }}>
                  confidence {res.confidence} · agreement {res.agreement} · n={res.samples}
                </span>
              </div>
              {res.rationale && <div style={{ marginBottom: 6 }}><strong>Rationale:</strong> {res.rationale}</div>}
              {res.cautions && res.cautions.map((c, i) => (
                <div key={i} style={{ padding: 8, marginBottom: 4, background: "#fdf0f0", border: "1px solid #f5d5d0", borderRadius: 6, fontSize: 11, color: "#993333" }}>{"⚠"} {c}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SnippetPicker({ snippets, onPick }) {
  const [open, setOpen] = useState(false);
  const items = Array.isArray(snippets) ? snippets : Object.entries(snippets).map(([, v]) => v);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <Btn small onClick={() => setOpen(!open)}>+ Snippet</Btn>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{
            position: "absolute", top: "100%", left: 0, zIndex: 50,
            background: "#fff", border: "1px solid #e8eaed", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)", maxHeight: 280,
            overflowY: "auto", width: 360, marginTop: 4,
          }}>
            {items.map((s, i) => (
              <button key={i} onClick={() => { onPick(s); setOpen(false); }} style={{
                display: "block", width: "100%", padding: "8px 12px",
                border: "none", borderBottom: "1px solid #f5f5f5",
                background: "none", cursor: "pointer", textAlign: "left",
                fontSize: 11, color: "#4a5568", lineHeight: 1.5,
              }}>{s}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ───── Classifications block (reused for LEFT and RIGHT) ─────
   Renders: Strengths text + the 12-issue checklist with per-issue
   justification AND required transcript-evidence fields. */
function ClassificationsBlock({ side, taxonomy, strength, setStrength, weak, setWeak, onCopyStrength }) {
  const updateIssue = (code, patch) =>
    setWeak(prev => prev.map(w => (w.code === code ? { ...w, ...patch } : w)));
  const toggleIssue = (code) =>
    setWeak(prev => prev.find(w => w.code === code)
      ? prev.filter(w => w.code !== code)
      : [...prev, { code, justification: "", evidence: "" }]);

  return (
    <>
      <Card
        tag={side}
        title="Strengths of Response"
        right={<><CharBadge len={strength.length} min={MIN_STRENGTH_CHARS} /><Btn small onClick={onCopyStrength} style={{ marginLeft: 4 }}>Copy</Btn></>}
      >
        <div style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <SnippetPicker snippets={STRENGTH_SNIPPETS} onPick={s => setStrength(prev => prev + s)} />
        </div>
        <textarea value={strength} onChange={e => setStrength(e.target.value)}
          placeholder={`What did the ${side} response do well? Be specific: files, tool calls, code changes, correctness.`}
          style={{ width: "100%", minHeight: 110, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }}
        />
      </Card>

      <Card tag={side} title="Identify issues (select all that apply)">
        {taxonomy.map(t => {
          const active = weak.find(w => w.code === t.code);
          const justOk = active && active.justification.length >= MIN_ISSUE_JUSTIFY_CHARS;
          const evidOk = active && active.evidence.length >= MIN_ISSUE_EVIDENCE_CHARS;
          return (
            <div key={t.code} style={{ borderBottom: "1px solid #f5f5f5" }}>
              <button onClick={() => toggleIssue(t.code)} style={{
                width: "100%", padding: "7px 8px", display: "flex", alignItems: "center", gap: 8,
                background: active ? "rgba(74,111,165,0.04)" : "none", border: "none", cursor: "pointer", textAlign: "left",
              }}>
                <span style={{ width: 16, height: 16, borderRadius: 3, border: `2px solid ${active ? "#4a6fa5" : "#d5d8dd"}`, background: active ? "#4a6fa5" : "#fff", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{active && "✓"}</span>
                <code style={{ fontSize: 10, fontWeight: 700, color: "#4a6fa5", fontFamily: "var(--mono)", minWidth: 72 }}>{t.code}</code>
                <span style={{ fontSize: 11, color: "#4a5568" }}>{t.label}</span>
              </button>
              {active && (
                <div style={{ padding: "0 8px 10px 34px" }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontStyle: "italic" }}>{t.desc}</div>

                  {/* Justification */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#4a5568" }}>Justification</span>
                    {WEAKNESS_SNIPPETS[t.code] && (
                      <SnippetPicker snippets={{ [t.code]: WEAKNESS_SNIPPETS[t.code] }} onPick={s => updateIssue(t.code, { justification: active.justification + s })} />
                    )}
                    <CharBadge len={active.justification.length} min={MIN_ISSUE_JUSTIFY_CHARS} />
                  </div>
                  <textarea value={active.justification} onChange={e => updateIssue(t.code, { justification: e.target.value })}
                    placeholder="Why is this an issue? What went wrong and why does it matter?"
                    style={{ width: "100%", minHeight: 44, padding: 8, borderRadius: 5, border: `1px solid ${justOk ? "#e8eaed" : "#f0c0b8"}`, fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", marginBottom: 8 }}
                  />

                  {/* Transcript evidence (anchoring) */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#4a5568" }}>Transcript evidence (quote / line)</span>
                    <CharBadge len={active.evidence.length} min={MIN_ISSUE_EVIDENCE_CHARS} />
                  </div>
                  <textarea value={active.evidence} onChange={e => updateIssue(t.code, { evidence: e.target.value })}
                    placeholder='Paste the exact quote or line ref, e.g. L142: "all tests pass" (no test was run)'
                    style={{ width: "100%", minHeight: 40, padding: 8, borderRadius: 5, border: `1px solid ${evidOk ? "#e8eaed" : "#f0c0b8"}`, fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc" }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}

/* ───── Comparison Worksheet (replaces the old regex auto-rating) ───── */
function WorksheetView({ worksheet, setScore, dimensions }) {
  const leftTotal = weightedTotal(worksheet, "L", dimensions);
  const rightTotal = weightedTotal(worksheet, "R", dimensions);
  const complete = worksheetComplete(worksheet, dimensions);
  const max = maxWeighted(dimensions);
  const { diff, bucket } = suggestBucket(leftTotal, rightTotal);

  const ScoreRow = ({ side, dim }) => (
    <div style={{ display: "flex", gap: 3 }}>
      {[1, 2, 3, 4, 5].map(n => {
        const sel = worksheet[dim.key]?.[side] === n;
        return (
          <button key={n} onClick={() => setScore(dim.key, side, sel ? null : n)} style={{
            width: 26, height: 26, borderRadius: 5,
            border: sel ? "2px solid #4a6fa5" : "1px solid #e8eaed",
            background: sel ? "#4a6fa5" : "#fff", color: sel ? "#fff" : "#9ca3af",
            fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--mono)",
          }}>{n}</button>
        );
      })}
    </div>
  );

  return (
    <Card tag="⚙" title="Comparison Worksheet (optional helper)">
      <div style={{ fontSize: 12, color: "#4a5568", marginTop: 0, marginBottom: 12, lineHeight: 1.6, background: "#f6f7f9", border: "1px solid #e8eaed", borderRadius: 8, padding: 10 }}>
        <div style={{ marginBottom: 6 }}><Badge text="OPTIONAL — not submitted" color="#8a6a10" bg="#fef8e8" /></div>
        <strong>What is this?</strong> A thinking aid. You give each side a 1–5 score on a few things
        (Is it correct? Did it follow instructions? etc.). The tool multiplies by the weights and adds them
        up to <em>suggest</em> a 0–7 preference.<br />
        <strong>Why bother?</strong> It stops you from picking a winner on gut feel — it forces you to
        compare the two sides on what actually matters (correctness first). The number it suggests is just
        a sanity check.<br />
        <strong>Do I have to?</strong> No. This is never sent anywhere. If you already know which side is
        better, click <em>“Next: LEFT classifications”</em> and skip it. 1 = poor on that dimension, 5 = excellent.
      </div>

      {dimensions.map(d => (
        <div key={d.key} style={{ padding: "8px 0", borderBottom: "1px solid #f5f5f5" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#1a1a2e" }}>{d.label}</span>
              <Badge text={`×${d.weight}`} color="#5a5a8a" bg="#f0f0fa" />
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6, fontStyle: "italic" }}>{d.desc}</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#1a8a45", minWidth: 36 }}>LEFT</span>
              <ScoreRow side="L" dim={d} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#993333", minWidth: 36 }}>RIGHT</span>
              <ScoreRow side="R" dim={d} />
            </div>
          </div>
        </div>
      ))}

      {/* Arithmetic + suggestion */}
      <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "#f6f7f9", border: "1px solid #e8eaed" }}>
        <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "#4a5568", lineHeight: 1.8 }}>
          <div>LEFT weighted total: <strong style={{ color: "#1a8a45" }}>{leftTotal}</strong> / {max}</div>
          <div>RIGHT weighted total: <strong style={{ color: "#993333" }}>{rightTotal}</strong> / {max}</div>
          <div>Difference (LEFT − RIGHT): <strong>{diff > 0 ? `+${diff}` : diff}</strong></div>
        </div>
        <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: bucket === null ? "#fff7e6" : "#eef4ff", border: "1px solid " + (bucket === null ? "#f0d8a0" : "#cfe0ff") }}>
          <Badge text="SUGGESTION — you must confirm" color="#8a6a10" bg="#fef8e8" />
          {!complete ? (
            <div style={{ fontSize: 12, color: "#8a6a10", marginTop: 6 }}>
              Score all {dimensions.length} dimensions for both sides to compute a suggested preference.
            </div>
          ) : bucket === null ? (
            <div style={{ fontSize: 13, color: "#8a6a10", marginTop: 6 }}>
              LEFT {leftTotal} = RIGHT {rightTotal} → exact tie. No neutral option exists — decide manually (3 or 4).
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "#1a1a2e", marginTop: 6, fontWeight: 600 }}>
              LEFT weighted {leftTotal} vs RIGHT {rightTotal} → suggests{" "}
              <span style={{ color: SCALE[bucket].c, fontWeight: 800 }}>{bucket}: {SCALE[bucket].label}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ───── Config editor (customize worksheet dimensions + issue taxonomy) ─────
   Renders inside a modal overlay. Edits are immediate and persisted by App. */
function ConfigEditor({ dimensions, setDimensions, taxonomy, setTaxonomy, onClose, onResetDimensions, onResetTaxonomy }) {
  const input = (value, onChange, extra = {}) => (
    <input value={value} onChange={e => onChange(e.target.value)} style={{
      border: "1px solid #e8eaed", borderRadius: 5, padding: "5px 8px", fontSize: 12,
      fontFamily: "var(--mono)", boxSizing: "border-box", ...extra,
    }} />
  );

  const updateDim = (i, patch) => setDimensions(prev => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const removeDim = (i) => setDimensions(prev => prev.filter((_, j) => j !== i));
  const addDim = () => setDimensions(prev => [...prev, { key: `dim_${Date.now()}`, label: "New dimension", weight: 1, desc: "" }]);

  const updateTax = (i, patch) => setTaxonomy(prev => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const removeTax = (i) => setTaxonomy(prev => prev.filter((_, j) => j !== i));
  const addTax = () => setTaxonomy(prev => [...prev, { code: `CODE${prev.length + 1}`, label: "New issue", desc: "" }]);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.35)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "24px 12px", overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#f6f7f9", borderRadius: 12, width: "100%", maxWidth: 720, boxShadow: "0 12px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e8eaed", background: "#fff", borderRadius: "12px 12px 0 0", position: "sticky", top: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>⚙ Customize</span>
          <Btn small onClick={onClose}>Done</Btn>
        </div>
        <div style={{ padding: 16 }}>

          {/* Dimensions */}
          <Card tag="WORKSHEET" title="Comparison dimensions" right={<Btn small onClick={onResetDimensions}>Reset defaults</Btn>}>
            <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 0 }}>Score each side 1–5; totals are weighted by these numbers. Total weight: <strong>{totalWeight(dimensions)}</strong>.</p>
            {dimensions.map((d, i) => (
              <div key={d.key} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                {input(d.label, v => updateDim(i, { label: v }), { flex: 1, minWidth: 140 })}
                <span style={{ fontSize: 10, color: "#6b7280" }}>weight</span>
                <input type="number" min={1} value={d.weight} onChange={e => updateDim(i, { weight: Math.max(1, Number(e.target.value) || 1) })}
                  style={{ width: 52, border: "1px solid #e8eaed", borderRadius: 5, padding: "5px 6px", fontSize: 12, fontFamily: "var(--mono)" }} />
                {input(d.desc || "", v => updateDim(i, { desc: v }), { flex: 2, minWidth: 160 })}
                <Btn small danger onClick={() => removeDim(i)} disabled={dimensions.length <= 1}>✕</Btn>
              </div>
            ))}
            <Btn small onClick={addDim} style={{ marginTop: 6 }}>+ Add dimension</Btn>
          </Card>

          {/* Taxonomy */}
          <Card tag="ISSUES" title="Issue taxonomy" right={<Btn small onClick={onResetTaxonomy}>Reset defaults</Btn>}>
            <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 0 }}>Codes shown as checkboxes on each response. Editing here updates both LEFT and RIGHT.</p>
            {taxonomy.map((t, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
                {input(t.code, v => updateTax(i, { code: v.toUpperCase().replace(/\s+/g, "") }), { width: 90 })}
                {input(t.label, v => updateTax(i, { label: v }), { flex: 1, minWidth: 140 })}
                {input(t.desc || "", v => updateTax(i, { desc: v }), { flex: 2, minWidth: 160 })}
                <Btn small danger onClick={() => removeTax(i)} disabled={taxonomy.length <= 1}>✕</Btn>
              </div>
            ))}
            <Btn small onClick={addTax} style={{ marginTop: 6 }}>+ Add issue code</Btn>
          </Card>

        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Main App
   ════════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [step, setStep] = useState(0);
  const [taskId, setTaskId] = usePersist("eval-taskId", "");
  const [taskPrompt, setTaskPrompt] = usePersist("eval-taskPrompt", "");

  // Transcripts (LEFT / RIGHT)
  const [transcriptLeft, setTranscriptLeft] = usePersist("eval-transcriptLeft", "");
  const [transcriptRight, setTranscriptRight] = usePersist("eval-transcriptRight", "");
  // Parsed views are derived from the transcripts; the effects below recompute
  // them on mount (with persisted text) and on every change.
  const [parsedLeft, setParsedLeft] = useState(null);
  const [parsedRight, setParsedRight] = useState(null);

  // Classifications (per side)
  const [strengthLeft, setStrengthLeft] = usePersist("eval-strengthLeft", "");
  const [strengthRight, setStrengthRight] = usePersist("eval-strengthRight", "");
  const [weakLeft, setWeakLeft] = usePersist("eval-weakLeft", []);   // [{code, justification, evidence}]
  const [weakRight, setWeakRight] = usePersist("eval-weakRight", []);

  // User-editable config (worksheet dimensions + issue taxonomy), persisted.
  const [dimensions, setDimensions] = usePersist("eval-dimensions", DEFAULT_DIMENSIONS);
  const [taxonomy, setTaxonomy] = usePersist("eval-taxonomy", DEFAULT_TAXONOMY);
  const [showConfig, setShowConfig] = useState(false);

  // Comparison worksheet
  const [worksheet, setWorksheet] = usePersist("eval-worksheet", blankWorksheet(DEFAULT_DIMENSIONS));

  // Shared preference + rationale
  const [pref, setPref] = usePersist("eval-pref", null);            // 0–7 or null
  const [rationale, setRationale] = usePersist("eval-rationale", "");

  // UI / meta
  const [toast, setToast] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [timing, setTiming] = useState(true);
  const timerRef = useRef(null);
  const { history, save, remove } = useHistory();

  useEffect(() => {
    if (timing) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
      return () => clearInterval(timerRef.current);
    } else {
      clearInterval(timerRef.current);
    }
  }, [timing]);

  // Parser is a reading aid only — it recomputes on transcript change, never writes answers.
  useEffect(() => { setParsedLeft(parseTranscript(transcriptLeft)); }, [transcriptLeft]);
  useEffect(() => { setParsedRight(parseTranscript(transcriptRight)); }, [transcriptRight]);

  // If an issue code is removed in the config editor, drop any selections that
  // reference it so they can't become hidden, unfixable validation errors.
  useEffect(() => {
    const codes = new Set(taxonomy.map(t => t.code));
    const prune = (list) => list.filter(w => codes.has(w.code));
    setWeakLeft(prev => (prev.some(w => !codes.has(w.code)) ? prune(prev) : prev));
    setWeakRight(prev => (prev.some(w => !codes.has(w.code)) ? prune(prev) : prev));
  }, [taxonomy]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const setScore = (dimKey, side, value) =>
    setWorksheet(prev => ({ ...prev, [dimKey]: { ...prev[dimKey], [side]: value } }));

  /* ── Export: Copy All (laid out to paste 1:1 into the form) ── */
  const formatIssues = (weak) => {
    if (weak.length === 0) return "  (none selected)";
    return weak.map(w => {
      const t = taxonomy.find(x => x.code === w.code);
      return `  [${w.code}] ${t ? t.label : ""}\n    Justification: ${w.justification}\n    Evidence: ${w.evidence}`;
    }).join("\n");
  };

  const copyAll = () => {
    const prefLine = pref !== null ? `${pref} — ${SCALE[pref].label}` : "Not selected";
    const text =
`TASK: ${taskId || "N/A"}

═══ LEFT — Strengths of Response ═══
${strengthLeft}

═══ LEFT — Issues ═══
${formatIssues(weakLeft)}

═══ RIGHT — Strengths of Response ═══
${strengthRight}

═══ RIGHT — Issues ═══
${formatIssues(weakRight)}

═══ Overall Preference ═══
${prefLine}

═══ Rationale ═══
${rationale}`;
    navigator.clipboard.writeText(text).then(() => flash("Copied — paste straight into the form"));
  };

  const copyField = (text) => navigator.clipboard.writeText(text).then(() => flash("Copied field"));

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({
      taskId,
      strengthLeft, strengthRight,
      issuesLeft: weakLeft, issuesRight: weakRight,
      worksheet,
      preference: pref,
      preferenceLabel: pref !== null ? SCALE[pref].label : null,
      rationale,
      timestamp: new Date().toISOString(),
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `eval-${taskId || Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    flash("Exported JSON");
  };

  const saveAndReset = () => {
    save({
      taskId, preference: pref,
      preferenceLabel: pref !== null ? SCALE[pref].label : null,
      strengthLeft, strengthRight, weakLeft, weakRight, worksheet, rationale,
    });
    setStep(0); setTaskPrompt(""); setTranscriptLeft(""); setTranscriptRight("");
    setParsedLeft(null); setParsedRight(null); setStrengthLeft(""); setStrengthRight("");
    setWeakLeft([]); setWeakRight([]); setWorksheet(blankWorksheet(dimensions));
    setPref(null); setRationale(""); setElapsed(0); setTaskId("");
    flash("Saved to history — fresh eval started");
  };

  /* ── Apply an AI auto-draft into the form (user reviews, then validates) ── */
  const applyDraft = (d) => {
    if (!d) return;
    if (typeof d.strengthLeft === "string") setStrengthLeft(d.strengthLeft);
    if (typeof d.strengthRight === "string") setStrengthRight(d.strengthRight);
    if (Array.isArray(d.weakLeft)) setWeakLeft(d.weakLeft);
    if (Array.isArray(d.weakRight)) setWeakRight(d.weakRight);
    if (d.worksheet) setWorksheet(d.worksheet);
    if (d.preference !== undefined) setPref(d.preference);
    if (typeof d.rationale === "string") setRationale(d.rationale);
    setStep(2); // jump to LEFT classifications so you can review top-to-bottom
    flash("AI draft applied — review LEFT → RIGHT → Preference, then Submit");
  };

  /* ── Validation: blocking errors vs non-blocking warnings ──
     Every free-text field is listed explicitly with its CURRENT length and the
     minimum, so "invalid character lengths" is never a mystery: each ✗ row names
     the exact box, where to find it, and how many more characters it needs. */
  const shortMsg = (where, label, len, min) =>
    len === 0
      ? `${where} → "${label}" is EMPTY (needs ${min}+ characters)`
      : `${where} → "${label}" is too short: ${len}/${min} — add ${min - len} more character${min - len === 1 ? "" : "s"}`;

  const freeTextFields = [
    { where: "LEFT tab", label: "Strengths of Response", len: strengthLeft.length, min: MIN_STRENGTH_CHARS },
    { where: "RIGHT tab", label: "Strengths of Response", len: strengthRight.length, min: MIN_STRENGTH_CHARS },
    ...weakLeft.flatMap(w => [
      { where: `LEFT tab · [${w.code}]`, label: "Justification", len: w.justification.length, min: MIN_ISSUE_JUSTIFY_CHARS },
      { where: `LEFT tab · [${w.code}]`, label: "Transcript evidence", len: w.evidence.length, min: MIN_ISSUE_EVIDENCE_CHARS },
    ]),
    ...weakRight.flatMap(w => [
      { where: `RIGHT tab · [${w.code}]`, label: "Justification", len: w.justification.length, min: MIN_ISSUE_JUSTIFY_CHARS },
      { where: `RIGHT tab · [${w.code}]`, label: "Transcript evidence", len: w.evidence.length, min: MIN_ISSUE_EVIDENCE_CHARS },
    ]),
    { where: "Preference tab", label: "Rationale", len: rationale.length, min: MIN_RATIONALE_CHARS },
  ];

  const errors = [];
  freeTextFields.forEach(f => { if (f.len < f.min) errors.push(shortMsg(f.where, f.label, f.len, f.min)); });
  if (pref === null) errors.push("Preference tab → no Overall Preference (0–7) selected");

  const warnings = [];
  // (1) Worksheet vs preference
  if (worksheetComplete(worksheet, dimensions) && pref !== null) {
    const lt = weightedTotal(worksheet, "L", dimensions);
    const rt = weightedTotal(worksheet, "R", dimensions);
    if (lt > rt && pref >= 4) warnings.push(`Worksheet favors LEFT (${lt} vs ${rt}) but preference ${pref} favors RIGHT`);
    if (rt > lt && pref <= 3) warnings.push(`Worksheet favors RIGHT (${rt} vs ${lt}) but preference ${pref} favors LEFT`);
  }
  // (2) Issue tags vs preference (more issues = worse; preference shouldn't favor the worse side)
  if (pref !== null) {
    if (weakLeft.length > weakRight.length && pref <= 3) warnings.push(`LEFT has more issues (${weakLeft.length} vs ${weakRight.length}) yet preference ${pref} favors LEFT`);
    if (weakRight.length > weakLeft.length && pref >= 4) warnings.push(`RIGHT has more issues (${weakRight.length} vs ${weakLeft.length}) yet preference ${pref} favors RIGHT`);
  }
  // (3) Preference vs rationale wording (keyword heuristic)
  if (pref !== null && rationale.length > 20) {
    const lower = rationale.toLowerCase();
    const leftSigs = ["left is better", "left handles", "left's solution", "prefer left", "left produces", "left is cleaner", "left model", "favor left", "left response"];
    const rightSigs = ["right is better", "right handles", "right's solution", "prefer right", "right produces", "right is cleaner", "right model", "favor right", "right response"];
    const mentionsLeft = leftSigs.some(s => lower.includes(s));
    const mentionsRight = rightSigs.some(s => lower.includes(s));
    if (pref <= 3 && mentionsRight && !mentionsLeft) warnings.push("Preference favors LEFT but rationale sounds pro-RIGHT");
    if (pref >= 4 && mentionsLeft && !mentionsRight) warnings.push("Preference favors RIGHT but rationale sounds pro-LEFT");
  }

  const steps = [
    { label: "Paste", icon: "📋" },
    { label: "Worksheet", icon: "⚙" },
    { label: "LEFT", icon: "◧" },
    { label: "RIGHT", icon: "◨" },
    { label: "Preference", icon: "⚖" },
    { label: "Submit", icon: "✓" },
    { label: "History", icon: "⏱" },
  ];

  return (
    <div style={{
      "--mono": "'SF Mono', 'Cascadia Code', Consolas, monospace",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#1a1a2e", minHeight: "100vh", background: "#f6f7f9",
    }}>
      {toast && (
        <div style={{
          position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)",
          padding: "8px 20px", borderRadius: 20, background: "#1a1a2e", color: "#fff",
          fontSize: 13, fontWeight: 600, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
        }}>{toast}</div>
      )}

      {/* Header */}
      <div style={{
        padding: "10px 14px", background: "#fff",
        borderBottom: "1px solid #e8eaed",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 800 }}>{"⚖"}</span>
          <input value={taskId} onChange={e => setTaskId(e.target.value)} placeholder="Task ID..."
            style={{ border: "1px solid #e8eaed", borderRadius: 5, padding: "2px 8px", fontSize: 12, fontFamily: "var(--mono)", width: 100, background: "#f9fafb" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: timing ? "#4a6fa5" : "#9ca3af" }}>{mm}:{ss}</span>
          <button onClick={() => setTiming(!timing)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#9ca3af" }}>{timing ? "⏸" : "▶"}</button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn small onClick={() => setShowConfig(true)}>⚙ Customize</Btn>
          <Btn small onClick={copyAll}>Copy All</Btn>
          <Btn small onClick={exportJSON}>JSON</Btn>
          <Btn small primary onClick={saveAndReset}>Save & New</Btn>
        </div>
      </div>

      {showConfig && (
        <ConfigEditor
          dimensions={dimensions} setDimensions={setDimensions}
          taxonomy={taxonomy} setTaxonomy={setTaxonomy}
          onClose={() => setShowConfig(false)}
          onResetDimensions={() => setDimensions(DEFAULT_DIMENSIONS)}
          onResetTaxonomy={() => setTaxonomy(DEFAULT_TAXONOMY)}
        />
      )}

      {/* Step nav */}
      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e8eaed", position: "sticky", top: 44, zIndex: 99 }}>
        {steps.map((s, i) => (
          <button key={i} onClick={() => setStep(i)} style={{
            flex: 1, padding: "8px 2px", border: "none",
            borderBottom: step === i ? "2px solid #4a6fa5" : "2px solid transparent",
            marginBottom: -1, background: "none", cursor: "pointer",
            color: step === i ? "#4a6fa5" : "#b0b5bd",
            fontWeight: step === i ? 700 : 500, fontSize: 11,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
          }}>
            <span style={{ fontSize: 12 }}>{s.icon}</span>{s.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "14px 12px", maxWidth: 720, margin: "0 auto" }}>

        {/* STEP 0: PASTE */}
        {step === 0 && (
          <>
            <Card tag="TASK" title="Prompt (what were both models asked to do?)">
              <textarea value={taskPrompt} onChange={e => setTaskPrompt(e.target.value)}
                placeholder="Paste the task prompt here... (context for your reading, optional)"
                style={{ width: "100%", minHeight: 80, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 12, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc" }}
              />
            </Card>
            <Card tag="◧ LEFT" title="Transcript — LEFT" right={parsedLeft && <Badge text={`${parsedLeft.toolCallCount} calls`} />}>
              <textarea value={transcriptLeft} onChange={e => setTranscriptLeft(e.target.value)}
                placeholder="Paste the LEFT model's full response/transcript (markdown is fine)..."
                style={{ width: "100%", minHeight: 150, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc", lineHeight: 1.5 }}
              />
              <ParsedView parsed={parsedLeft} />
            </Card>
            <Card tag="◨ RIGHT" title="Transcript — RIGHT" right={parsedRight && <Badge text={`${parsedRight.toolCallCount} calls`} />}>
              <textarea value={transcriptRight} onChange={e => setTranscriptRight(e.target.value)}
                placeholder="Paste the RIGHT model's full response/transcript (markdown is fine)..."
                style={{ width: "100%", minHeight: 150, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc", lineHeight: 1.5 }}
              />
              <ParsedView parsed={parsedRight} />
            </Card>
            <Btn primary onClick={() => setStep(1)} style={{ width: "100%" }}>Next: Worksheet {"→"}</Btn>
          </>
        )}

        {/* STEP 1: WORKSHEET */}
        {step === 1 && (
          <>
            <SuggestionCard left={transcriptLeft} right={transcriptRight} />
            <JudgePanel task={taskPrompt} left={transcriptLeft} right={transcriptRight}
              dimensions={dimensions} taxonomy={taxonomy} onApply={applyDraft} />
            <WorksheetView worksheet={worksheet} setScore={setScore} dimensions={dimensions} />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(0)}>{"←"} Back</Btn>
              <Btn primary onClick={() => setStep(2)} style={{ flex: 1 }}>Next: LEFT classifications {"→"}</Btn>
            </div>
            <p style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 8 }}>
              The worksheet structures your reasoning and proposes a preference. It never fills your answers.
            </p>
          </>
        )}

        {/* STEP 2: LEFT classifications */}
        {step === 2 && (
          <>
            <ClassificationsBlock
              side="LEFT" taxonomy={taxonomy} strength={strengthLeft} setStrength={setStrengthLeft}
              weak={weakLeft} setWeak={setWeakLeft} onCopyStrength={() => copyField(strengthLeft)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(1)}>{"←"} Back</Btn>
              <Btn primary onClick={() => setStep(3)} style={{ flex: 1 }}>Next: RIGHT {"→"}</Btn>
            </div>
          </>
        )}

        {/* STEP 3: RIGHT classifications */}
        {step === 3 && (
          <>
            <ClassificationsBlock
              side="RIGHT" taxonomy={taxonomy} strength={strengthRight} setStrength={setStrengthRight}
              weak={weakRight} setWeak={setWeakRight} onCopyStrength={() => copyField(strengthRight)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(2)}>{"←"} Back</Btn>
              <Btn primary onClick={() => setStep(4)} style={{ flex: 1 }}>Next: Preference {"→"}</Btn>
            </div>
          </>
        )}

        {/* STEP 4: OVERALL PREFERENCE + RATIONALE */}
        {step === 4 && (
          <>
            <Card tag={"⚖"} title="Overall Preference (0 = LEFT … 7 = RIGHT)">
              <div style={{ fontSize: 12, color: "#4a5568", marginTop: 0, marginBottom: 10, lineHeight: 1.6, background: "#f6f7f9", border: "1px solid #e8eaed", borderRadius: 8, padding: 10 }}>
                <strong>What you're answering:</strong> "Which response is better, and by how much?" One number, 0–7.
                There is no neutral middle — you must lean one way.<br />
                <strong>Left half (0–3) = LEFT is better. Right half (4–7) = RIGHT is better.</strong> The further
                from the middle, the bigger the gap:
                <span style={{ display: "block", marginTop: 4, fontFamily: "var(--mono)", fontSize: 11 }}>
                  0/7 = one side is clearly correct and the other is terrible &nbsp;·&nbsp; 3/4 = very close, could go either way
                </span>
                <strong>Rule of thumb:</strong> correct final code beats a tidy-but-wrong answer. Pick the number,
                then make sure your rationale below argues for the same side.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {SCALE.map(s => (
                  <button key={s.val} onClick={() => setPref(s.val)} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", borderRadius: 7,
                    border: pref === s.val ? `2px solid ${s.c}` : "1px solid #e8eaed",
                    background: pref === s.val ? s.c + "10" : "#fff",
                    cursor: "pointer", transition: "all 0.1s",
                  }}>
                    <span style={{ width: 26, height: 26, borderRadius: "50%", background: pref === s.val ? s.c : "#e8eaed", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, fontFamily: "var(--mono)" }}>{s.val}</span>
                    <span style={{ fontSize: 13, fontWeight: pref === s.val ? 700 : 400, color: pref === s.val ? s.c : "#6b7280" }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </Card>
            <Card tag={"✎"} title="Rationale" right={<Btn small onClick={() => copyField(rationale)}>Copy</Btn>}>
              <textarea value={rationale} onChange={e => setRationale(e.target.value)}
                placeholder="Single paragraph. Key differences. Specific evidence from both sides. Must match the preference direction."
                style={{ width: "100%", minHeight: 120, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <CharBadge len={rationale.length} min={MIN_RATIONALE_CHARS} />
                <span style={{ fontSize: 11, color: "#9ca3af" }}>{rationale.split(/\s+/).filter(Boolean).length} words</span>
              </div>
            </Card>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(3)}>{"←"} Back</Btn>
              <Btn primary onClick={() => setStep(5)} style={{ flex: 1 }}>Check & Submit {"→"}</Btn>
            </div>
          </>
        )}

        {/* STEP 5: VALIDATE */}
        {step === 5 && (
          <>
            <Card tag={errors.length === 0 ? "✓" : "✗"} title="Validation (blocking)">
              {errors.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", background: "#e8f5ee", borderRadius: 8 }}>
                  <div style={{ fontSize: 40, marginBottom: 6 }}>{"✓"}</div>
                  <div style={{ fontWeight: 700, color: "#1a7a3a", fontSize: 16 }}>No blocking issues</div>
                  <div style={{ fontSize: 12, color: "#4a8a5a", marginTop: 4 }}>Time: {mm}:{ss}</div>
                </div>
              ) : (
                errors.map((e, i) => (
                  <div key={i} style={{ padding: "7px 10px", borderRadius: 5, background: "#fef2f0", border: "1px solid #f5d5d0", fontSize: 12, color: "#c44", fontWeight: 500, marginBottom: 4 }}>{"✗"} {e}</div>
                ))
              )}
            </Card>

            <Card tag={"🅰"} title="Free-text fields — character check">
              <p style={{ fontSize: 11, color: "#6b7280", marginTop: 0, marginBottom: 8 }}>
                If the form says <em>“Cannot submit — some free text classifications have invalid character lengths,”</em>
                it means one of these boxes is below its minimum (or empty). Each ✗ below is the exact culprit — its
                tab, which field, and how many characters to add.
              </p>
              <div style={{ fontSize: 12, fontFamily: "var(--mono)", lineHeight: 1.7 }}>
                {freeTextFields.map((f, i) => {
                  const ok = f.len >= f.min;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <span style={{ color: ok ? "#1a7a3a" : "#c44", fontWeight: 800, width: 14 }}>{ok ? "✓" : "✗"}</span>
                      <span style={{ color: ok ? "#4a5568" : "#c44" }}>
                        {f.where} → {f.label}: <strong>{f.len}/{f.min}</strong>{!ok && (f.len === 0 ? " (empty)" : ` — add ${f.min - f.len}`)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>

            {warnings.length > 0 && (
              <Card tag={"⚠"} title="Consistency warnings (non-blocking)">
                {warnings.map((w, i) => (
                  <div key={i} style={{ padding: "7px 10px", borderRadius: 5, background: "#fef8e8", border: "1px solid #f0e0a8", fontSize: 12, color: "#8a6a10", fontWeight: 500, marginBottom: 4 }}>{"⚠"} {w}</div>
                ))}
                <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 0 }}>These flag possible inconsistencies. Review them, but you may proceed if you disagree.</p>
              </Card>
            )}

            <Card tag={"📋"} title="Final Summary">
              <div style={{ fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2, color: "#4a5568" }}>
                <div><strong>Task:</strong> {taskId || "—"}</div>
                <div><strong>Preference:</strong> {pref !== null ? <span style={{ color: SCALE[pref].c, fontWeight: 700 }}>{pref} — {SCALE[pref].label}</span> : "—"}</div>
                <div><strong>LEFT strengths:</strong> {strengthLeft.length} chars | <strong>RIGHT strengths:</strong> {strengthRight.length} chars</div>
                <div><strong>LEFT issues:</strong> {weakLeft.length > 0 ? weakLeft.map(w => w.code).join(", ") : "None"}</div>
                <div><strong>RIGHT issues:</strong> {weakRight.length > 0 ? weakRight.map(w => w.code).join(", ") : "None"}</div>
                <div><strong>Worksheet:</strong> LEFT {weightedTotal(worksheet, "L", dimensions)} vs RIGHT {weightedTotal(worksheet, "R", dimensions)} {worksheetComplete(worksheet, dimensions) ? "" : "(incomplete)"}</div>
                <div><strong>Rationale:</strong> {rationale.split(/\s+/).filter(Boolean).length} words</div>
                <div><strong>Time:</strong> {mm}:{ss}</div>
              </div>
            </Card>

            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(4)}>{"←"} Back</Btn>
              <Btn primary onClick={copyAll} style={{ flex: 1 }}>{"📋"} Copy Everything</Btn>
              <Btn small onClick={exportJSON}>JSON</Btn>
            </div>
          </>
        )}

        {/* STEP 6: HISTORY */}
        {step === 6 && (
          <Card tag={"⏱"} title={`Past Evaluations (${history.length})`}>
            {history.length === 0 ? (
              <p style={{ fontSize: 13, color: "#9ca3af", textAlign: "center", padding: 20 }}>
                No saved evaluations yet. Use "Save & New" to archive your current eval.
              </p>
            ) : (
              history.map((h, i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "10px 0", borderBottom: "1px solid #f0f1f3",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {h.taskId || `Eval #${history.length - i}`}
                      {h.preference !== null && h.preference !== undefined && (
                        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: SCALE[h.preference].c }}>{h.preferenceLabel}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      {new Date(h.savedAt).toLocaleDateString()} {new Date(h.savedAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <Btn small danger onClick={() => remove(i)}>Remove</Btn>
                </div>
              ))
            )}
          </Card>
        )}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(-8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        * { -webkit-tap-highlight-color: transparent; }
        textarea:focus, input:focus { outline: 2px solid #4a6fa5; outline-offset: -1px; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #d0d5dd; border-radius: 3px; }
      `}</style>
    </div>
  );
}
