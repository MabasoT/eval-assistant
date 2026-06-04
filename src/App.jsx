import { useState, useEffect, useRef } from "react";

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

/* ───── Issue taxonomy (12 codes — labels verbatim from the form) ───── */
const TAXONOMY = [
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

/* ───── Overall Preference scale (0 = LEFT strongest … 7 = RIGHT strongest) ─────
   Color ramp: LEFT side green, RIGHT side red. */
const SCALE = [
  { val: 0, label: "LEFT strongly preferred", c: "#0d6832" },
  { val: 1, label: "LEFT preferred", c: "#1a8a45" },
  { val: 2, label: "LEFT slightly preferred", c: "#4aaa6a" },
  { val: 3, label: "LEFT marginally preferred", c: "#7cc095" },
  { val: 4, label: "RIGHT marginally preferred", c: "#c07878" },
  { val: 5, label: "RIGHT slightly preferred", c: "#b05050" },
  { val: 6, label: "RIGHT preferred", c: "#993333" },
  { val: 7, label: "RIGHT strongly preferred", c: "#7a1a1a" },
];

/* ───── Comparison Worksheet dimensions (weighted scoring) ─────
   You score each dimension 1–5 for LEFT and RIGHT; weighted totals feed a
   SUGGESTED preference bucket (advisory only). */
const DIMENSIONS = [
  { key: "correctness", label: "Correctness", weight: 3, desc: "Does the change actually work / solve the task?" },
  { key: "instruction", label: "Instruction-following", weight: 3, desc: "Did it do what was asked, no more, no less?" },
  { key: "completeness", label: "Completeness", weight: 2, desc: "Fully done — no TODOs, stubs, half-measures?" },
  { key: "safety", label: "Safety / No destructive ops", weight: 2, desc: "Avoided unsafe/irreversible actions?" },
  { key: "conciseness", label: "Conciseness / Formatting", weight: 1, desc: "Tight, well-formatted, no filler?" },
];

const TOTAL_WEIGHT = DIMENSIONS.reduce((s, d) => s + d.weight, 0); // 11
const MAX_WEIGHTED = TOTAL_WEIGHT * 5;                              // 55

/* Build an empty worksheet: { correctness: {L:null, R:null}, ... } */
const blankWorksheet = () => Object.fromEntries(DIMENSIONS.map(d => [d.key, { L: null, R: null }]));

/* ───── Pure scoring helpers (easy to unit-test, no UI coupling) ───── */

/** Weighted total for one side ("L" or "R"). Unscored dims count as 0. */
function weightedTotal(worksheet, side) {
  return DIMENSIONS.reduce((sum, d) => {
    const v = worksheet[d.key]?.[side];
    return sum + (typeof v === "number" ? v * d.weight : 0);
  }, 0);
}

/** Is every dimension scored for both sides? */
function worksheetComplete(worksheet) {
  return DIMENSIONS.every(d => {
    const cell = worksheet[d.key] || {};
    return typeof cell.L === "number" && typeof cell.R === "number";
  });
}

/**
 * Map the LEFT-vs-RIGHT weighted difference to a SUGGESTED 0–7 bucket.
 *   diff = leftTotal - rightTotal   (positive favors LEFT → buckets 3..0,
 *                                     negative favors RIGHT → buckets 4..7)
 * Magnitude bands pick the strength tier (marginal/slightly/preferred/strongly).
 * Returns { diff, mag, level, bucket } where bucket is null on a tie.
 */
function suggestBucket(leftTotal, rightTotal) {
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

/* ───── Transcript Parser (READING AID ONLY — never auto-populates answers) ─────
   Scans a pasted transcript for structural signals (tool calls, files, TODOs,
   success claims, errors) to help you locate evidence faster. */
function parseTranscript(text) {
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const toolCalls = [];
  const filesEdited = new Set();
  const filesRead = new Set();
  const commands = [];
  const todos = [];
  const successClaims = [];
  const errors = [];

  const toolPatterns = [
    /str_replace|str_replace_editor/i,
    /create_file|file_edit|write_file/i,
    /read_file|view_file|cat\s/i,
    /grep|find\s|rg\s|ag\s/i,
    /bash|execute|terminal|shell/i,
    /search|list_dir/i,
  ];

  const filePattern = /(?:(?:\/[\w.-]+)+(?:\.[\w]+)?)|(?:[\w.-]+\.(?:py|js|ts|jsx|tsx|rs|go|rb|java|c|cpp|h|hpp|css|html|json|yaml|yml|toml|md|txt|cfg|ini|sh|sql))/g;
  const todoPattern = /(?:TODO|FIXME|XXX|HACK|placeholder|implement\s+this|pass\s*#|\.\.\.(?:\s*#|\s*$))/gi;
  const successPattern = /(?:successfully|completed|all tests pass|this (?:should|will) (?:fix|work|resolve)|fix(?:ed|es) the (?:issue|bug|problem)|changes are (?:complete|done))/gi;
  const errorPattern = /(?:error|Error|ERROR|traceback|Traceback|exception|Exception|failed|FAILED|panic|PANIC)/g;
  const editPatterns = /(?:str_replace|create_file|file_edit|write_file|insert_text|patch)/i;
  const readPatterns = /(?:read_file|view_file|cat |head |tail |less )/i;
  const bashContent = /```(?:bash|sh|shell)?\n([\s\S]*?)```/gi;

  let match;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of toolPatterns) {
      if (pat.test(line)) {
        toolCalls.push({ line: i + 1, text: line.trim().substring(0, 120) });
        break;
      }
    }
    if (editPatterns.test(line)) {
      const files = line.match(filePattern);
      if (files) files.forEach(f => filesEdited.add(f));
    }
    if (readPatterns.test(line)) {
      const files = line.match(filePattern);
      if (files) files.forEach(f => filesRead.add(f));
    }
    while ((match = todoPattern.exec(line)) !== null) {
      todos.push({ line: i + 1, text: line.trim().substring(0, 100) });
    }
    while ((match = successPattern.exec(line)) !== null) {
      successClaims.push({ line: i + 1, text: line.trim().substring(0, 100) });
    }
    while ((match = errorPattern.exec(line)) !== null) {
      errors.push({ line: i + 1, text: line.trim().substring(0, 100) });
    }
  }

  while ((match = bashContent.exec(text)) !== null) {
    commands.push(match[1].trim().substring(0, 120));
  }

  return {
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.slice(0, 30),
    filesEdited: [...filesEdited].slice(0, 20),
    filesRead: [...filesRead].slice(0, 20),
    commands: [...new Set(commands)].slice(0, 15),
    todos,
    successClaims,
    errors: errors.slice(0, 20),
    lineCount: lines.length,
    charCount: text.length,
  };
}

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
        <Badge text={`${parsed.filesEdited.length} files edited`} color="#8a5a1a" bg="#fef8e8" />
        <Badge text={`${parsed.lineCount} lines`} color="#5a5a8a" bg="#f0f0fa" />
        {parsed.todos.length > 0 && <Badge text={`${parsed.todos.length} TODOs !`} color="#c44" bg="#fef2f0" />}
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
function ClassificationsBlock({ side, strength, setStrength, weak, setWeak, onCopyStrength }) {
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
        {TAXONOMY.map(t => {
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
                    <SnippetPicker snippets={{ [t.code]: WEAKNESS_SNIPPETS[t.code] }} onPick={s => updateIssue(t.code, { justification: active.justification + s })} />
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
function WorksheetView({ worksheet, setScore }) {
  const leftTotal = weightedTotal(worksheet, "L");
  const rightTotal = weightedTotal(worksheet, "R");
  const complete = worksheetComplete(worksheet);
  const { diff, bucket } = suggestBucket(leftTotal, rightTotal);

  const ScoreRow = ({ side, dim }) => (
    <div style={{ display: "flex", gap: 3 }}>
      {[1, 2, 3, 4, 5].map(n => {
        const sel = worksheet[dim.key][side] === n;
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
    <Card tag="⚙" title="Comparison Worksheet — score each side 1–5">
      <p style={{ fontSize: 11, color: "#6b7280", marginTop: 0, marginBottom: 12 }}>
        Weighted dimensions help you reason structurally. This produces a <strong>suggestion only</strong>;
        the official Overall Preference is a separate, manual choice on the next step.
      </p>

      {DIMENSIONS.map(d => (
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
          <div>LEFT weighted total: <strong style={{ color: "#1a8a45" }}>{leftTotal}</strong> / {MAX_WEIGHTED}</div>
          <div>RIGHT weighted total: <strong style={{ color: "#993333" }}>{rightTotal}</strong> / {MAX_WEIGHTED}</div>
          <div>Difference (LEFT − RIGHT): <strong>{diff > 0 ? `+${diff}` : diff}</strong></div>
        </div>
        <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: bucket === null ? "#fff7e6" : "#eef4ff", border: "1px solid " + (bucket === null ? "#f0d8a0" : "#cfe0ff") }}>
          <Badge text="SUGGESTION — you must confirm" color="#8a6a10" bg="#fef8e8" />
          {!complete ? (
            <div style={{ fontSize: 12, color: "#8a6a10", marginTop: 6 }}>
              Score all {DIMENSIONS.length} dimensions for both sides to compute a suggested preference.
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

  // Comparison worksheet
  const [worksheet, setWorksheet] = usePersist("eval-worksheet", blankWorksheet());

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

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const setScore = (dimKey, side, value) =>
    setWorksheet(prev => ({ ...prev, [dimKey]: { ...prev[dimKey], [side]: value } }));

  /* ── Export: Copy All (laid out to paste 1:1 into the form) ── */
  const formatIssues = (weak) => {
    if (weak.length === 0) return "  (none selected)";
    return weak.map(w => {
      const t = TAXONOMY.find(x => x.code === w.code);
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
    setWeakLeft([]); setWeakRight([]); setWorksheet(blankWorksheet());
    setPref(null); setRationale(""); setElapsed(0); setTaskId("");
    flash("Saved to history — fresh eval started");
  };

  /* ── Validation: blocking errors vs non-blocking warnings ── */
  const errors = [];
  if (strengthLeft.length < MIN_STRENGTH_CHARS) errors.push(`LEFT strengths: ${MIN_STRENGTH_CHARS - strengthLeft.length} chars short (min ${MIN_STRENGTH_CHARS})`);
  if (strengthRight.length < MIN_STRENGTH_CHARS) errors.push(`RIGHT strengths: ${MIN_STRENGTH_CHARS - strengthRight.length} chars short (min ${MIN_STRENGTH_CHARS})`);
  weakLeft.forEach(w => {
    if (w.justification.length < MIN_ISSUE_JUSTIFY_CHARS) errors.push(`LEFT [${w.code}] justification < ${MIN_ISSUE_JUSTIFY_CHARS} chars`);
    if (w.evidence.length < MIN_ISSUE_EVIDENCE_CHARS) errors.push(`LEFT [${w.code}] evidence < ${MIN_ISSUE_EVIDENCE_CHARS} chars`);
  });
  weakRight.forEach(w => {
    if (w.justification.length < MIN_ISSUE_JUSTIFY_CHARS) errors.push(`RIGHT [${w.code}] justification < ${MIN_ISSUE_JUSTIFY_CHARS} chars`);
    if (w.evidence.length < MIN_ISSUE_EVIDENCE_CHARS) errors.push(`RIGHT [${w.code}] evidence < ${MIN_ISSUE_EVIDENCE_CHARS} chars`);
  });
  if (pref === null) errors.push("No Overall Preference selected");
  if (rationale.length < MIN_RATIONALE_CHARS) errors.push(`Rationale < ${MIN_RATIONALE_CHARS} chars`);

  const warnings = [];
  // (1) Worksheet vs preference
  if (worksheetComplete(worksheet) && pref !== null) {
    const lt = weightedTotal(worksheet, "L");
    const rt = weightedTotal(worksheet, "R");
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
          <Btn small onClick={copyAll}>Copy All</Btn>
          <Btn small onClick={exportJSON}>JSON</Btn>
          <Btn small primary onClick={saveAndReset}>Save & New</Btn>
        </div>
      </div>

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
            <WorksheetView worksheet={worksheet} setScore={setScore} />
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
              side="LEFT" strength={strengthLeft} setStrength={setStrengthLeft}
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
              side="RIGHT" strength={strengthRight} setStrength={setStrengthRight}
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
              <p style={{ fontSize: 11, color: "#6b7280", marginTop: 0, marginBottom: 10 }}>
                0 is the strongest preference for the LEFT model. 7 is the strongest preference for the RIGHT model.
              </p>
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
                <div><strong>Worksheet:</strong> LEFT {weightedTotal(worksheet, "L")} vs RIGHT {weightedTotal(worksheet, "R")} {worksheetComplete(worksheet) ? "" : "(incomplete)"}</div>
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
