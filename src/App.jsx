import { useState, useEffect, useRef } from "react";

/* ───── Constants ───── */
const TAXONOMY = [
  { code: "INST", label: "Instruction Following", desc: "Ignored or misunderstood explicit instructions", signals: ["didn't follow prompt", "missed requirement", "ignored constraint"] },
  { code: "OVERENG", label: "Overengineering", desc: "Unnecessarily complex; unrequested features", signals: ["added unrequested", "unnecessary abstraction", "beyond scope"] },
  { code: "TOOL", label: "Tool Use Errors", desc: "Incorrect use of tools, APIs, or commands", signals: ["wrong tool", "bad arguments", "tool error"] },
  { code: "LAZY", label: "Laziness", desc: "Incomplete, gives up early, TODOs/placeholders", signals: ["TODO", "placeholder", "left as exercise", "...", "# implement"] },
  { code: "VERIFY", label: "Verification Failures", desc: "Claims without checking", signals: ["should work", "this will fix", "no test run"] },
  { code: "FALSE", label: "False Claims of Success", desc: "Says it works when it doesn't", signals: ["successfully", "all tests pass", "completed"] },
  { code: "ROOT", label: "Fails Root Cause", desc: "Fixes symptoms not the cause", signals: ["try/except", "suppress error", "workaround"] },
  { code: "DESTRUCT", label: "Destructive Ops", desc: "Unsafe/irreversible actions", signals: ["rm -rf", "drop table", "force push", "delete"] },
  { code: "FILE", label: "File Issues", desc: "Wrong paths, wrong files modified", signals: ["wrong file", "created unnecessary", "wrong path"] },
  { code: "HALLUC", label: "Hallucinations", desc: "References non-existent functions/files/APIs", signals: ["doesn't exist", "no such method", "fabricated"] },
  { code: "DOCS", label: "Doc Issues", desc: "Unwanted docs or bad comments", signals: ["unnecessary comment", "added docstring", "documentation not asked"] },
  { code: "VERBOSE", label: "Verbose/Format", desc: "Too long, filler, excessive markdown", signals: ["filler", "unnecessary explanation", "over-formatted"] },
];

const SCALE = [
  { val: 0, label: "A Highly Preferred", c: "#0d6832" },
  { val: 1, label: "A Preferred", c: "#1a8a45" },
  { val: 2, label: "A Slightly Preferred", c: "#4aaa6a" },
  { val: 3, label: "A Minimally Preferred", c: "#7cc095" },
  { val: 4, label: "B Minimally Preferred", c: "#c07878" },
  { val: 5, label: "B Slightly Preferred", c: "#b05050" },
  { val: 6, label: "B Preferred", c: "#993333" },
  { val: 7, label: "B Highly Preferred", c: "#7a1a1a" },
];

/* ───── Transcript Parser ───── */
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

/* ───── Smart Local Analysis (replaces AI API) ───── */
function smartAnalysis(parsedA, parsedB, transcriptA, transcriptB, taskPrompt) {
  if (!parsedA || !parsedB) return null;

  const buildStrength = (parsed, transcript, label) => {
    const parts = [];

    // Tool usage analysis
    if (parsed.toolCallCount > 0) {
      parts.push(`Model ${label} made ${parsed.toolCallCount} tool call${parsed.toolCallCount > 1 ? "s" : ""}, demonstrating active engagement with the codebase.`);
    }

    // File reading before editing
    if (parsed.filesRead.length > 0 && parsed.filesEdited.length > 0) {
      parts.push(`Model read ${parsed.filesRead.length} file${parsed.filesRead.length > 1 ? "s" : ""} (${parsed.filesRead.slice(0, 3).join(", ")}${parsed.filesRead.length > 3 ? "..." : ""}) before editing, showing good understanding of context.`);
    }

    // Files edited
    if (parsed.filesEdited.length > 0) {
      parts.push(`Modified ${parsed.filesEdited.length} file${parsed.filesEdited.length > 1 ? "s" : ""}: ${parsed.filesEdited.slice(0, 4).join(", ")}${parsed.filesEdited.length > 4 ? "..." : ""}.`);
    }

    // Commands run
    if (parsed.commands.length > 0) {
      parts.push(`Ran ${parsed.commands.length} command${parsed.commands.length > 1 ? "s" : ""} for verification/setup.`);
    }

    // No TODOs
    if (parsed.todos.length === 0 && parsed.filesEdited.length > 0) {
      parts.push("Final code contains no TODOs or placeholders — implementation appears complete.");
    }

    // Fallback
    if (parts.length < 2) {
      parts.push(`[EDIT: Review transcript ${label} and add specific evidence of what the model did well — file names, tool calls, code quality.]`);
    }

    return parts.join(" ");
  };

  const buildWeaknesses = (parsed, transcript) => {
    const weaknesses = [];

    // TODOs found
    if (parsed.todos.length > 0) {
      weaknesses.push({
        code: "LAZY",
        justification: `Found ${parsed.todos.length} TODO/placeholder${parsed.todos.length > 1 ? "s" : ""}: "${parsed.todos[0].text}" (line ${parsed.todos[0].line})${parsed.todos.length > 1 ? ` and ${parsed.todos.length - 1} more` : ""}. [VERIFY: Check if these are in final code or just in reading.]`
      });
    }

    // Success claims without verification
    if (parsed.successClaims.length > 0 && parsed.commands.length === 0) {
      weaknesses.push({
        code: "VERIFY",
        justification: `Made ${parsed.successClaims.length} success claim${parsed.successClaims.length > 1 ? "s" : ""} (e.g., "${parsed.successClaims[0].text}") but ran no commands to verify. [CHECK: Did the model test its changes?]`
      });
    }

    // False success claims
    if (parsed.successClaims.length > 0 && parsed.errors.length > 0) {
      weaknesses.push({
        code: "FALSE",
        justification: `Claims success ("${parsed.successClaims[0].text.substring(0, 50)}") but ${parsed.errors.length} error${parsed.errors.length > 1 ? "s were" : " was"} detected in the transcript. [VERIFY: Check if errors were resolved later.]`
      });
    }

    // No files read before editing
    if (parsed.filesEdited.length > 0 && parsed.filesRead.length === 0) {
      weaknesses.push({
        code: "VERIFY",
        justification: `Edited ${parsed.filesEdited.length} file${parsed.filesEdited.length > 1 ? "s" : ""} without first reading them to understand existing code. [CHECK: Model may have read files via other means not detected by parser.]`
      });
    }

    // Destructive commands
    const destructivePatterns = /rm\s+-rf|drop\s+table|--force|force\s+push|git\s+reset\s+--hard|truncate/i;
    if (parsed.commands.some(c => destructivePatterns.test(c))) {
      const cmd = parsed.commands.find(c => destructivePatterns.test(c));
      weaknesses.push({
        code: "DESTRUCT",
        justification: `Ran potentially destructive command: "${cmd.substring(0, 80)}". [VERIFY: Was this necessary and safe?]`
      });
    }

    // Excessive verbosity (very long transcripts with few edits)
    if (parsed.lineCount > 500 && parsed.filesEdited.length <= 2) {
      weaknesses.push({
        code: "VERBOSE",
        justification: `Transcript is ${parsed.lineCount} lines but only ${parsed.filesEdited.length} file${parsed.filesEdited.length !== 1 ? "s were" : " was"} edited. Response may be unnecessarily verbose. [CHECK: Is the extra content valuable explanation or filler?]`
      });
    }

    return weaknesses;
  };

  const suggestRating = (parsedA, parsedB, weakA, weakB) => {
    let score = 0; // negative = A better, positive = B better

    // TODOs
    score += (parsedA.todos.length - parsedB.todos.length) * 0.5;

    // Completeness (files edited as proxy)
    if (parsedA.filesEdited.length > parsedB.filesEdited.length) score -= 0.3;
    if (parsedB.filesEdited.length > parsedA.filesEdited.length) score += 0.3;

    // Verification (ran commands)
    if (parsedA.commands.length > 0 && parsedB.commands.length === 0) score -= 0.5;
    if (parsedB.commands.length > 0 && parsedA.commands.length === 0) score += 0.5;

    // Weakness count
    score += (weakA.length - weakB.length) * 0.3;

    // Errors
    if (parsedA.errors.length > parsedB.errors.length) score += 0.3;
    if (parsedB.errors.length > parsedA.errors.length) score -= 0.3;

    // Map score to rating
    if (score <= -1.5) return 0;
    if (score <= -0.8) return 1;
    if (score <= -0.3) return 2;
    if (score <= 0.3) return 3;
    if (score <= 0.8) return 4;
    if (score <= 1.5) return 5;
    if (score <= 2.0) return 6;
    return 7;
  };

  const buildRationale = (parsedA, parsedB, weakA, weakB, suggestedRating) => {
    const parts = [];
    const preferred = suggestedRating <= 3 ? "A" : "B";
    const other = preferred === "A" ? "B" : "A";
    const pParsed = preferred === "A" ? parsedA : parsedB;
    const oParsed = preferred === "A" ? parsedB : parsedA;
    const pWeak = preferred === "A" ? weakA : weakB;
    const oWeak = preferred === "A" ? weakB : weakA;

    parts.push(`Response ${preferred} is preferred.`);

    // Tool call comparison
    if (pParsed.toolCallCount !== oParsed.toolCallCount) {
      parts.push(`${preferred} made ${pParsed.toolCallCount} tool calls vs ${other}'s ${oParsed.toolCallCount}.`);
    }

    // File edit comparison
    if (pParsed.filesEdited.length !== oParsed.filesEdited.length) {
      parts.push(`${preferred} edited ${pParsed.filesEdited.length} file${pParsed.filesEdited.length !== 1 ? "s" : ""} vs ${other}'s ${oParsed.filesEdited.length}.`);
    }

    // Weakness comparison
    if (oWeak.length > pWeak.length) {
      parts.push(`${other} has ${oWeak.length} weakness${oWeak.length !== 1 ? "es" : ""} (${oWeak.map(w => w.code).join(", ")}) vs ${preferred}'s ${pWeak.length || "none"}.`);
    }

    // TODO comparison
    if (oParsed.todos.length > 0 && pParsed.todos.length === 0) {
      parts.push(`${other} left ${oParsed.todos.length} TODO/placeholder${oParsed.todos.length !== 1 ? "s" : ""} while ${preferred}'s code is complete.`);
    }

    parts.push("[EDIT: Add your own assessment of final code quality, correctness, and whether the task was actually completed by each model.]");

    return parts.join(" ");
  };

  const buildKeyDifferences = (parsedA, parsedB) => {
    const diffs = [];

    if (parsedA.toolCallCount !== parsedB.toolCallCount) {
      diffs.push(`Tool call count: A=${parsedA.toolCallCount}, B=${parsedB.toolCallCount}`);
    }
    if (parsedA.filesEdited.length !== parsedB.filesEdited.length) {
      diffs.push(`Files edited: A=${parsedA.filesEdited.length}, B=${parsedB.filesEdited.length}`);
    }
    if (parsedA.todos.length !== parsedB.todos.length) {
      diffs.push(`TODOs: A=${parsedA.todos.length}, B=${parsedB.todos.length}`);
    }
    if (parsedA.commands.length !== parsedB.commands.length) {
      diffs.push(`Commands run: A=${parsedA.commands.length}, B=${parsedB.commands.length}`);
    }
    if (parsedA.errors.length !== parsedB.errors.length) {
      diffs.push(`Errors detected: A=${parsedA.errors.length}, B=${parsedB.errors.length}`);
    }
    if (parsedA.lineCount > 0 && parsedB.lineCount > 0) {
      const ratio = Math.max(parsedA.lineCount, parsedB.lineCount) / Math.min(parsedA.lineCount, parsedB.lineCount);
      if (ratio > 1.5) {
        diffs.push(`Length: A=${parsedA.lineCount} lines, B=${parsedB.lineCount} lines (${ratio.toFixed(1)}x difference)`);
      }
    }

    if (diffs.length === 0) diffs.push("No major structural differences detected — review code quality manually");
    return diffs;
  };

  const strengthA = buildStrength(parsedA, transcriptA, "A");
  const strengthB = buildStrength(parsedB, transcriptB, "B");
  const weaknessesA = buildWeaknesses(parsedA, transcriptA);
  const weaknessesB = buildWeaknesses(parsedB, transcriptB);
  const suggestedRating = suggestRating(parsedA, parsedB, weaknessesA, weaknessesB);
  const rationale = buildRationale(parsedA, parsedB, weaknessesA, weaknessesB, suggestedRating);
  const keyDifferences = buildKeyDifferences(parsedA, parsedB);

  return {
    strengthA,
    strengthB,
    weaknessesA,
    weaknessesB,
    suggestedRating,
    rationale,
    keyDifferences,
    confidence: weaknessesA.length + weaknessesB.length > 0 ? "medium" : "low",
    notes: "This is a heuristic-based draft from parsed transcript data. You MUST review the actual code changes and edit every field. Brackets like [EDIT:...] and [VERIFY:...] mark areas needing your judgment.",
  };
}

/* ───── Snippets for quick-fill ───── */
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

/* ───── Components ───── */
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
  if (!parsed) return <p style={{ fontSize: 12, color: "#9ca3af", padding: 10 }}>Paste a transcript to see analysis</p>;
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
  const items = Array.isArray(snippets) ? snippets : Object.entries(snippets).map(([k, v]) => v);
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

/* ───── Main App ───── */
export default function App() {
  const [step, setStep] = useState(0);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [transcriptA, setTranscriptA] = useState("");
  const [transcriptB, setTranscriptB] = useState("");
  const [parsedA, setParsedA] = useState(null);
  const [parsedB, setParsedB] = useState(null);
  const [strengthA, setStrengthA] = useState("");
  const [strengthB, setStrengthB] = useState("");
  const [weakA, setWeakA] = useState([]);
  const [weakB, setWeakB] = useState([]);
  const [rating, setRating] = useState(null);
  const [rationale, setRationale] = useState("");
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysisDone, setAnalysisDone] = useState(false);
  const [toast, setToast] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [timing, setTiming] = useState(true);
  const [taskId, setTaskId] = useState("");
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

  useEffect(() => { if (transcriptA) setParsedA(parseTranscript(transcriptA)); }, [transcriptA]);
  useEffect(() => { if (transcriptB) setParsedB(parseTranscript(transcriptB)); }, [transcriptB]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const runAnalysis = () => {
    if (!transcriptA.trim() || !transcriptB.trim()) { flash("Paste both transcripts first"); return; }
    const result = smartAnalysis(parsedA, parsedB, transcriptA, transcriptB, taskPrompt);
    if (result) {
      setAnalysisResult(result);
      setStrengthA(result.strengthA || "");
      setStrengthB(result.strengthB || "");
      setWeakA(result.weaknessesA || []);
      setWeakB(result.weaknessesB || []);
      setRating(result.suggestedRating ?? null);
      setRationale(result.rationale || "");
      setAnalysisDone(true);
      flash("Draft ready -- review and edit everything");
      setStep(2);
    } else {
      flash("Analysis failed -- fill manually");
    }
  };

  const toggleWeak = (setter, code) => {
    setter(prev => prev.find(w => w.code === code) ? prev.filter(w => w.code !== code) : [...prev, { code, justification: "" }]);
  };

  const copyAll = () => {
    const text = `TASK: ${taskId || "N/A"}\n\nSTRENGTHS A:\n${strengthA}\n\nWEAKNESSES A:\n${weakA.map(w => `[${w.code}] ${w.justification}`).join("\n") || "None"}\n\nSTRENGTHS B:\n${strengthB}\n\nWEAKNESSES B:\n${weakB.map(w => `[${w.code}] ${w.justification}`).join("\n") || "None"}\n\nRATING: ${rating !== null ? `${rating} -- ${SCALE[rating].label}` : "Not set"}\n\nRATIONALE:\n${rationale}`;
    navigator.clipboard.writeText(text).then(() => flash("Copied!"));
  };

  const copyField = (text) => navigator.clipboard.writeText(text).then(() => flash("Copied field"));

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({
      taskId, strengthA, strengthB,
      weaknessesA: weakA, weaknessesB: weakB,
      rating, ratingLabel: rating !== null ? SCALE[rating].label : null,
      rationale, timestamp: new Date().toISOString(),
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `eval-${taskId || Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    flash("Exported JSON");
  };

  const saveAndReset = () => {
    save({ taskId, rating, ratingLabel: rating !== null ? SCALE[rating].label : null, strengthA, strengthB, weakA, weakB, rationale });
    setStep(0); setTaskPrompt(""); setTranscriptA(""); setTranscriptB("");
    setParsedA(null); setParsedB(null); setStrengthA(""); setStrengthB("");
    setWeakA([]); setWeakB([]); setRating(null); setRationale("");
    setAnalysisDone(false); setAnalysisResult(null); setElapsed(0); setTaskId("");
    flash("Saved to history -- fresh eval started");
  };

  const errors = [];
  if (strengthA.length < 200) errors.push("Strength A: " + (200 - strengthA.length) + " chars short");
  if (strengthB.length < 200) errors.push("Strength B: " + (200 - strengthB.length) + " chars short");
  weakA.forEach(w => { if (w.justification.length < 20) errors.push(`A [${w.code}] justification < 20 chars`); });
  weakB.forEach(w => { if (w.justification.length < 20) errors.push(`B [${w.code}] justification < 20 chars`); });
  if (rating === null) errors.push("No rating");
  if (rationale.length < 50) errors.push("Rationale too short");

  // Rating-rationale alignment check
  if (rating !== null && rationale.length > 20) {
    const lower = rationale.toLowerCase();
    const aSigs = ["a is better", "a handles", "a's solution", "prefer a", "a produces", "a is cleaner", "response a"];
    const bSigs = ["b is better", "b handles", "b's solution", "prefer b", "b produces", "b is cleaner", "response b"];
    const mentionsA = aSigs.some(s => lower.includes(s));
    const mentionsB = bSigs.some(s => lower.includes(s));
    if (rating <= 3 && mentionsB && !mentionsA) errors.push("Rating favors A but rationale sounds pro-B");
    if (rating >= 4 && mentionsA && !mentionsB) errors.push("Rating favors B but rationale sounds pro-A");
  }

  const steps = [
    { label: "Paste", icon: "📋" },
    { label: "Analyze", icon: "🔍" },
    { label: "Review A", icon: "A" },
    { label: "Review B", icon: "B" },
    { label: "Rate", icon: "⚖" },
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
                placeholder="Paste the task prompt here... (helps analysis, but optional)"
                style={{ width: "100%", minHeight: 80, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 12, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc" }}
              />
            </Card>
            <Card tag="A" title="Transcript A" right={parsedA && <Badge text={`${parsedA.toolCallCount} calls`} />}>
              <textarea value={transcriptA} onChange={e => setTranscriptA(e.target.value)}
                placeholder="Paste Response A's full transcript..."
                style={{ width: "100%", minHeight: 150, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc", lineHeight: 1.5 }}
              />
              <ParsedView parsed={parsedA} />
            </Card>
            <Card tag="B" title="Transcript B" right={parsedB && <Badge text={`${parsedB.toolCallCount} calls`} />}>
              <textarea value={transcriptB} onChange={e => setTranscriptB(e.target.value)}
                placeholder="Paste Response B's full transcript..."
                style={{ width: "100%", minHeight: 150, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box", background: "#fafbfc", lineHeight: 1.5 }}
              />
              <ParsedView parsed={parsedB} />
            </Card>
            <Btn primary onClick={() => setStep(1)} style={{ width: "100%" }}>Next: Analyze {"→"}</Btn>
          </>
        )}

        {/* STEP 1: ANALYZE */}
        {step === 1 && (
          <>
            <Card tag="A" title="Extracted -- Response A">
              <ParsedView parsed={parsedA} />
            </Card>
            <Card tag="B" title="Extracted -- Response B">
              <ParsedView parsed={parsedB} />
            </Card>

            {analysisResult && (
              <Card tag="DRAFT" title={`Analysis Confidence: ${analysisResult.confidence || "?"}`}>
                <div style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.6 }}>
                  {analysisResult.keyDifferences && (
                    <div style={{ marginBottom: 8 }}>
                      <strong>Key differences spotted:</strong>
                      {analysisResult.keyDifferences.map((d, i) => <div key={i} style={{ paddingLeft: 10 }}>* {d}</div>)}
                    </div>
                  )}
                  {analysisResult.notes && <div style={{ padding: 8, background: "#fef8e8", borderRadius: 6, fontSize: 11 }}>{"💡"} {analysisResult.notes}</div>}
                </div>
              </Card>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(0)}>{"←"} Back</Btn>
              <Btn primary onClick={runAnalysis} style={{ flex: 1 }}>
                {analysisDone ? "Re-run Smart Analysis" : "🔍 Generate Smart Draft"}
              </Btn>
              <Btn onClick={() => setStep(2)}>Skip {"→"}</Btn>
            </div>
            <p style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 8 }}>
              Smart analysis drafts from transcript patterns. You must read transcripts and edit everything.
            </p>
          </>
        )}

        {/* STEP 2: REVIEW A */}
        {step === 2 && (
          <>
            <Card tag="A" title="Strengths" right={<><CharBadge len={strengthA.length} min={200} /><Btn small onClick={() => copyField(strengthA)} style={{ marginLeft: 4 }}>Copy</Btn></>}>
              <div style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <SnippetPicker snippets={STRENGTH_SNIPPETS} onPick={s => setStrengthA(prev => prev + s)} />
                {analysisDone && <Badge text="Draft applied" color="#1a7a3a" bg="#e8f5ee" />}
              </div>
              <textarea value={strengthA} onChange={e => setStrengthA(e.target.value)}
                placeholder="What did A do well? Specific files, tool calls, code changes..."
                style={{ width: "100%", minHeight: 110, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }}
              />
            </Card>
            <Card tag="A" title="Weaknesses">
              {TAXONOMY.map(t => {
                const active = weakA.find(w => w.code === t.code);
                return (
                  <div key={t.code} style={{ borderBottom: "1px solid #f5f5f5" }}>
                    <button onClick={() => toggleWeak(setWeakA, t.code)} style={{
                      width: "100%", padding: "7px 8px", display: "flex", alignItems: "center", gap: 8,
                      background: active ? "rgba(74,111,165,0.04)" : "none", border: "none", cursor: "pointer", textAlign: "left",
                    }}>
                      <span style={{ width: 16, height: 16, borderRadius: 3, border: `2px solid ${active ? "#4a6fa5" : "#d5d8dd"}`, background: active ? "#4a6fa5" : "#fff", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{active && "✓"}</span>
                      <code style={{ fontSize: 10, fontWeight: 700, color: "#4a6fa5", fontFamily: "var(--mono)", minWidth: 65 }}>{t.code}</code>
                      <span style={{ fontSize: 11, color: "#4a5568" }}>{t.label}</span>
                    </button>
                    {active && (
                      <div style={{ padding: "0 8px 8px 34px" }}>
                        <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                          <SnippetPicker snippets={{ [t.code]: WEAKNESS_SNIPPETS[t.code] }} onPick={s => setWeakA(prev => prev.map(w => w.code === t.code ? { ...w, justification: w.justification + s } : w))} />
                          <CharBadge len={active.justification.length} min={20} />
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontStyle: "italic" }}>{t.desc}</div>
                        <textarea value={active.justification} onChange={e => setWeakA(prev => prev.map(w => w.code === t.code ? { ...w, justification: e.target.value } : w))}
                          placeholder="Evidence..."
                          style={{ width: "100%", minHeight: 44, padding: 8, borderRadius: 5, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box" }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(1)}>{"←"} Back</Btn>
              <Btn primary onClick={() => setStep(3)} style={{ flex: 1 }}>Next: Review B {"→"}</Btn>
            </div>
          </>
        )}

        {/* STEP 3: REVIEW B */}
        {step === 3 && (
          <>
            <Card tag="B" title="Strengths" right={<><CharBadge len={strengthB.length} min={200} /><Btn small onClick={() => copyField(strengthB)} style={{ marginLeft: 4 }}>Copy</Btn></>}>
              <div style={{ marginBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <SnippetPicker snippets={STRENGTH_SNIPPETS} onPick={s => setStrengthB(prev => prev + s)} />
              </div>
              <textarea value={strengthB} onChange={e => setStrengthB(e.target.value)}
                placeholder="What did B do well? Specific files, tool calls, code changes..."
                style={{ width: "100%", minHeight: 110, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }}
              />
            </Card>
            <Card tag="B" title="Weaknesses">
              {TAXONOMY.map(t => {
                const active = weakB.find(w => w.code === t.code);
                return (
                  <div key={t.code} style={{ borderBottom: "1px solid #f5f5f5" }}>
                    <button onClick={() => toggleWeak(setWeakB, t.code)} style={{
                      width: "100%", padding: "7px 8px", display: "flex", alignItems: "center", gap: 8,
                      background: active ? "rgba(74,111,165,0.04)" : "none", border: "none", cursor: "pointer", textAlign: "left",
                    }}>
                      <span style={{ width: 16, height: 16, borderRadius: 3, border: `2px solid ${active ? "#4a6fa5" : "#d5d8dd"}`, background: active ? "#4a6fa5" : "#fff", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{active && "✓"}</span>
                      <code style={{ fontSize: 10, fontWeight: 700, color: "#4a6fa5", fontFamily: "var(--mono)", minWidth: 65 }}>{t.code}</code>
                      <span style={{ fontSize: 11, color: "#4a5568" }}>{t.label}</span>
                    </button>
                    {active && (
                      <div style={{ padding: "0 8px 8px 34px" }}>
                        <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                          <SnippetPicker snippets={{ [t.code]: WEAKNESS_SNIPPETS[t.code] }} onPick={s => setWeakB(prev => prev.map(w => w.code === t.code ? { ...w, justification: w.justification + s } : w))} />
                          <CharBadge len={active.justification.length} min={20} />
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontStyle: "italic" }}>{t.desc}</div>
                        <textarea value={active.justification} onChange={e => setWeakB(prev => prev.map(w => w.code === t.code ? { ...w, justification: e.target.value } : w))}
                          placeholder="Evidence..."
                          style={{ width: "100%", minHeight: 44, padding: 8, borderRadius: 5, border: "1px solid #e8eaed", fontSize: 11, fontFamily: "var(--mono)", resize: "vertical", boxSizing: "border-box" }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep(2)}>{"←"} Back</Btn>
              <Btn primary onClick={() => setStep(4)} style={{ flex: 1 }}>Next: Rate {"→"}</Btn>
            </div>
          </>
        )}

        {/* STEP 4: RATE */}
        {step === 4 && (
          <>
            <Card tag={"⚖"} title="Rating">
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {SCALE.map(s => (
                  <button key={s.val} onClick={() => setRating(s.val)} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", borderRadius: 7,
                    border: rating === s.val ? `2px solid ${s.c}` : "1px solid #e8eaed",
                    background: rating === s.val ? s.c + "10" : "#fff",
                    cursor: "pointer", transition: "all 0.1s",
                  }}>
                    <span style={{ width: 26, height: 26, borderRadius: "50%", background: rating === s.val ? s.c : "#e8eaed", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, fontFamily: "var(--mono)" }}>{s.val}</span>
                    <span style={{ fontSize: 13, fontWeight: rating === s.val ? 700 : 400, color: rating === s.val ? s.c : "#6b7280" }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </Card>
            <Card tag={"✎"} title="Rationale" right={<Btn small onClick={() => copyField(rationale)}>Copy</Btn>}>
              <textarea value={rationale} onChange={e => setRationale(e.target.value)}
                placeholder="Single paragraph. Key differences. Specific evidence from both. Must match rating direction."
                style={{ width: "100%", minHeight: 120, padding: 10, borderRadius: 6, border: "1px solid #e8eaed", fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <CharBadge len={rationale.length} min={50} />
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
            <Card tag={errors.length === 0 ? "✓" : "✗"} title="Validation">
              {errors.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", background: "#e8f5ee", borderRadius: 8 }}>
                  <div style={{ fontSize: 40, marginBottom: 6 }}>{"✓"}</div>
                  <div style={{ fontWeight: 700, color: "#1a7a3a", fontSize: 16 }}>Ready to submit</div>
                  <div style={{ fontSize: 12, color: "#4a8a5a", marginTop: 4 }}>Time: {mm}:{ss}</div>
                </div>
              ) : (
                errors.map((e, i) => (
                  <div key={i} style={{ padding: "7px 10px", borderRadius: 5, background: "#fef2f0", border: "1px solid #f5d5d0", fontSize: 12, color: "#c44", fontWeight: 500, marginBottom: 4 }}>{"✗"} {e}</div>
                ))
              )}
            </Card>

            <Card tag={"📋"} title="Final Summary">
              <div style={{ fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2, color: "#4a5568" }}>
                <div><strong>Task:</strong> {taskId || "—"}</div>
                <div><strong>Rating:</strong> {rating !== null ? <span style={{ color: SCALE[rating].c, fontWeight: 700 }}>{rating} -- {SCALE[rating].label}</span> : "—"}</div>
                <div><strong>A strengths:</strong> {strengthA.length} chars | <strong>B strengths:</strong> {strengthB.length} chars</div>
                <div><strong>A weaknesses:</strong> {weakA.length > 0 ? weakA.map(w => w.code).join(", ") : "None"}</div>
                <div><strong>B weaknesses:</strong> {weakB.length > 0 ? weakB.map(w => w.code).join(", ") : "None"}</div>
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
                      {h.rating !== null && (
                        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: SCALE[h.rating].c }}>{h.ratingLabel}</span>
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
