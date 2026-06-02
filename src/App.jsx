import { useState, useEffect, useCallback } from "react";

const TAXONOMY = [
  { code: "INST", label: "Instruction Following Failures", desc: "Ignored or misunderstood explicit instructions from the prompt or config" },
  { code: "OVERENG", label: "Overengineering", desc: "Unnecessarily complex; adds unrequested features or scope" },
  { code: "TOOL", label: "Tool Use Errors", desc: "Incorrect or inappropriate use of tools, APIs, or commands" },
  { code: "LAZY", label: "Laziness", desc: "Incomplete, gives up early, or leaves TODOs/placeholders in final code" },
  { code: "VERIFY", label: "Verification Failures", desc: "Claims made without checking the repo or reasoning through correctness" },
  { code: "FALSE", label: "False Claims of Success", desc: "Says something works or was completed when it was not" },
  { code: "ROOT", label: "Fails to Address Root Cause", desc: "Fixes symptoms rather than the actual underlying issue" },
  { code: "DESTRUCT", label: "Unauthorized Destructive Ops", desc: "Unsafe/irreversible actions without justification" },
  { code: "FILE", label: "File-Related Issues", desc: "Incorrect file paths, wrong files modified, unnecessary files created" },
  { code: "HALLUC", label: "Code Hallucinations", desc: "References functions, files, APIs, or behavior that do not exist" },
  { code: "DOCS", label: "Documentation Issues", desc: "Unwanted documentation or bad/unnecessary comments" },
  { code: "VERBOSE", label: "Verbose / Formatting", desc: "Excessively long responses, unnecessary filler, excessive markdown" },
];

const SCALE = [
  { val: 0, label: "A Highly Preferred", color: "#0d6832", bg: "#e8f5ee" },
  { val: 1, label: "A Preferred", color: "#1a8a45", bg: "#edf8f0" },
  { val: 2, label: "A Slightly Preferred", color: "#4aaa6a", bg: "#f0faf3" },
  { val: 3, label: "A Minimally Preferred", color: "#7cc095", bg: "#f5fcf7" },
  { val: 4, label: "B Minimally Preferred", color: "#c07878", bg: "#fdf5f5" },
  { val: 5, label: "B Slightly Preferred", color: "#b05050", bg: "#faf0f0" },
  { val: 6, label: "B Preferred", color: "#993333", bg: "#f8eded" },
  { val: 7, label: "B Highly Preferred", color: "#7a1a1a", bg: "#f5e8e8" },
];

const CHECKLIST = [
  { group: "Prep", items: ["Read the full prompt — noted ALL requirements and constraints"] },
  { group: "Response A", items: [
    "Pass 1: Skimmed transcript shape and arc",
    "Pass 2: Tracked all file mutations (str_replace, create_file, bash edits)",
    "Pass 3: Validated final code logic against prompt requirements",
    "Formed independent assessment of A"
  ]},
  { group: "Response B", items: [
    "Pass 1: Skimmed transcript shape and arc",
    "Pass 2: Tracked all file mutations",
    "Pass 3: Validated final code logic against prompt requirements",
    "Formed independent assessment of B"
  ]},
  { group: "Compare", items: [
    "Compared final code quality (not just process)",
    "Checked weaknesses applied symmetrically",
    "Rating direction matches rationale",
    "Strengths ≥ 200 chars, weakness justifications ≥ 20 chars"
  ]},
];

const INITIAL_STATE = {
  strengthA: "", strengthB: "",
  weakA: [], weakB: [],
  rating: null, rationale: "",
  notesA: "", notesB: "",
  checklist: CHECKLIST.flatMap(g => g.items).map(() => false),
  taskId: "",
};

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

function CharBadge({ len, min }) {
  const met = len >= min;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 10,
      fontSize: 11, fontWeight: 600,
      fontFamily: "var(--mono)",
      background: met ? "#e8f5ee" : "#fef2f0",
      color: met ? "#1a7a3a" : "#c44",
    }}>
      {len}/{min} {met ? "✓" : "✗"}
    </span>
  );
}

function Card({ title, tag, children, actions }) {
  return (
    <div style={{
      background: "#fff", borderRadius: 12,
      border: "1px solid var(--border)",
      marginBottom: 20, overflow: "hidden",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{
        padding: "12px 18px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {tag && <span style={{
            padding: "2px 8px", borderRadius: 6,
            background: "var(--accent)", color: "#fff",
            fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)",
          }}>{tag}</span>}
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#1a1a2e" }}>{title}</h3>
        </div>
        {actions && <div style={{ display: "flex", gap: 6 }}>{actions}</div>}
      </div>
      <div style={{ padding: "14px 18px" }}>{children}</div>
    </div>
  );
}

function SmallBtn({ children, onClick, variant = "default" }) {
  const styles = {
    default: { bg: "#f4f5f7", color: "#4a5568", border: "#e2e5ea" },
    primary: { bg: "var(--accent)", color: "#fff", border: "var(--accent)" },
    danger: { bg: "#fef2f0", color: "#c44", border: "#f5d5d0" },
    success: { bg: "#e8f5ee", color: "#1a7a3a", border: "#c5e8d0" },
  };
  const s = styles[variant];
  return (
    <button onClick={onClick} style={{
      padding: "4px 10px", borderRadius: 6,
      border: `1px solid ${s.border}`, background: s.bg,
      color: s.color, fontSize: 11, fontWeight: 600,
      cursor: "pointer", whiteSpace: "nowrap",
    }}>{children}</button>
  );
}

function WeaknessSelector({ weaknesses, setWeaknesses }) {
  const toggle = (code) => {
    setWeaknesses(prev =>
      prev.find(w => w.code === code)
        ? prev.filter(w => w.code !== code)
        : [...prev, { code, justification: "" }]
    );
  };
  const updateJust = (code, val) =>
    setWeaknesses(prev => prev.map(w => w.code === code ? { ...w, justification: val } : w));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {TAXONOMY.map(t => {
        const active = weaknesses.find(w => w.code === t.code);
        return (
          <div key={t.code} style={{
            border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 8,
            background: active ? "rgba(74,111,165,0.04)" : "#fff",
            transition: "all 0.15s",
          }}>
            <button onClick={() => toggle(t.code)} style={{
              width: "100%", padding: "8px 12px",
              display: "flex", alignItems: "center", gap: 10,
              background: "none", border: "none", cursor: "pointer", textAlign: "left",
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                border: `2px solid ${active ? "var(--accent)" : "#d0d5dd"}`,
                background: active ? "var(--accent)" : "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 10, fontWeight: 800, transition: "all 0.15s",
              }}>{active && "✓"}</span>
              <code style={{
                fontSize: 11, fontWeight: 700, color: "var(--accent)",
                fontFamily: "var(--mono)", minWidth: 72,
              }}>{t.code}</code>
              <span style={{ fontSize: 12, color: "#1a1a2e", fontWeight: 500 }}>{t.label}</span>
            </button>
            {active && (
              <div style={{ padding: "0 12px 10px" }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontStyle: "italic" }}>{t.desc}</div>
                <textarea
                  value={active.justification}
                  onChange={e => updateJust(t.code, e.target.value)}
                  placeholder="Evidence: file names, tool calls, code snippets..."
                  style={{
                    width: "100%", minHeight: 50, padding: 10,
                    borderRadius: 6, border: "1px solid var(--border)",
                    background: "#f9fafb", color: "#1a1a2e",
                    fontSize: 12, fontFamily: "var(--mono)",
                    resize: "vertical", boxSizing: "border-box",
                  }}
                />
                <CharBadge len={active.justification.length} min={20} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Timer() {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{
        fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700,
        color: running ? "var(--accent)" : "#6b7280",
        minWidth: 52,
      }}>{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}</span>
      <SmallBtn onClick={() => setRunning(!running)}>{running ? "Pause" : "Start"}</SmallBtn>
      <SmallBtn onClick={() => { setSeconds(0); setRunning(false); }}>Reset</SmallBtn>
    </div>
  );
}

export default function App() {
  const [data, setData] = usePersist("eval-current", INITIAL_STATE);
  const [tab, setTab] = useState("workflow");
  const [toast, setToast] = useState(null);
  const { history, save, remove } = useHistory();

  const update = (key, val) => setData(prev => ({ ...prev, [key]: val }));
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2000); };

  const allCheckItems = CHECKLIST.flatMap(g => g.items);
  const progress = data.checklist.filter(Boolean).length;

  const copyToClipboard = () => {
    const text = `TASK: ${data.taskId || "N/A"}

STRENGTHS A:
${data.strengthA}

WEAKNESSES A:
${data.weakA.map(w => `[${w.code}] ${w.justification}`).join("\n") || "None"}

STRENGTHS B:
${data.strengthB}

WEAKNESSES B:
${data.weakB.map(w => `[${w.code}] ${w.justification}`).join("\n") || "None"}

RATING: ${data.rating !== null ? `${data.rating} — ${SCALE[data.rating].label}` : "Not set"}

RATIONALE:
${data.rationale}`;
    navigator.clipboard.writeText(text).then(() => showToast("Copied to clipboard"));
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({
      taskId: data.taskId,
      strengthA: data.strengthA, strengthB: data.strengthB,
      weaknessesA: data.weakA, weaknessesB: data.weakB,
      rating: data.rating,
      ratingLabel: data.rating !== null ? SCALE[data.rating].label : null,
      rationale: data.rationale,
      timestamp: new Date().toISOString(),
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `eval-${data.taskId || Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    showToast("Exported JSON");
  };

  const saveAndReset = () => {
    save({
      taskId: data.taskId, rating: data.rating,
      ratingLabel: data.rating !== null ? SCALE[data.rating].label : null,
      strengthA: data.strengthA, strengthB: data.strengthB,
      weakA: data.weakA, weakB: data.weakB, rationale: data.rationale,
    });
    setData(INITIAL_STATE);
    setTab("workflow");
    showToast("Saved to history — fresh eval started");
  };

  const errors = [];
  if (data.strengthA.length < 200) errors.push(`Strength A: ${200 - data.strengthA.length} more chars needed`);
  if (data.strengthB.length < 200) errors.push(`Strength B: ${200 - data.strengthB.length} more chars needed`);
  data.weakA.forEach(w => { if (w.justification.length < 20) errors.push(`Weakness A [${w.code}]: justification too short`); });
  data.weakB.forEach(w => { if (w.justification.length < 20) errors.push(`Weakness B [${w.code}]: justification too short`); });
  if (data.rating === null) errors.push("No rating selected");
  if (data.rationale.length < 50) errors.push("Rationale too short (min ~50 chars)");

  const symmetryWarns = [];
  const aCodes = new Set(data.weakA.map(w => w.code));
  const bCodes = new Set(data.weakB.map(w => w.code));
  ["VERIFY", "LAZY", "FALSE", "HALLUC"].forEach(code => {
    if (aCodes.has(code) && !bCodes.has(code)) symmetryWarns.push(`${code} flagged for A but not B`);
    if (bCodes.has(code) && !aCodes.has(code)) symmetryWarns.push(`${code} flagged for B but not A`);
  });

  if (data.rating !== null && data.rationale.length > 20) {
    const lower = data.rationale.toLowerCase();
    const aSigs = ["a is better", "a handles", "a's solution", "prefer a", "a produces", "a is cleaner"];
    const bSigs = ["b is better", "b handles", "b's solution", "prefer b", "b produces", "b is cleaner"];
    const mentionsA = aSigs.some(s => lower.includes(s));
    const mentionsB = bSigs.some(s => lower.includes(s));
    if (data.rating <= 3 && mentionsB && !mentionsA) errors.push("⚠ Rating favors A but rationale sounds pro-B");
    if (data.rating >= 4 && mentionsA && !mentionsB) errors.push("⚠ Rating favors B but rationale sounds pro-A");
  }

  const tabs = [
    { id: "workflow", icon: "◎", label: "Workflow" },
    { id: "a", icon: "A", label: "Response A" },
    { id: "b", icon: "B", label: "Response B" },
    { id: "rate", icon: "⚖", label: "Rate" },
    { id: "check", icon: "✓", label: "Check" },
    { id: "history", icon: "⏱", label: "History" },
  ];

  return (
    <div style={{
      "--accent": "#4a6fa5",
      "--border": "#e2e5ea",
      "--mono": "'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontFamily: "'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#1a1a2e",
      minHeight: "100vh",
      background: "#f4f5f7",
    }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
          padding: "8px 20px", borderRadius: 8, background: "#1a1a2e", color: "#fff",
          fontSize: 13, fontWeight: 600, zIndex: 999, boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
          animation: "fadeIn 0.2s ease",
        }}>{toast}</div>
      )}

      {/* Header */}
      <div style={{
        padding: "12px 16px", background: "#fff",
        borderBottom: "1px solid var(--border)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-0.03em" }}>⚖ Eval Assistant</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <input
              value={data.taskId}
              onChange={e => update("taskId", e.target.value)}
              placeholder="Task ID..."
              style={{
                border: "1px solid var(--border)", borderRadius: 5,
                padding: "2px 8px", fontSize: 12, fontFamily: "var(--mono)",
                width: 120, background: "#f9fafb",
              }}
            />
            <Timer />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <SmallBtn onClick={copyToClipboard}>Copy</SmallBtn>
          <SmallBtn onClick={exportJSON}>JSON</SmallBtn>
          <SmallBtn onClick={saveAndReset} variant="primary">Save & New</SmallBtn>
        </div>
      </div>

      {/* Tabs */}
      <div style={{
        display: "flex", background: "#fff",
        borderBottom: "2px solid var(--border)",
        overflowX: "auto", position: "sticky", top: 76, zIndex: 99,
      }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: "9px 4px", border: "none",
            borderBottom: tab === t.id ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: -2, background: "none", cursor: "pointer",
            color: tab === t.id ? "var(--accent)" : "#9ca3af",
            fontWeight: tab === t.id ? 700 : 500,
            fontSize: 11, display: "flex", alignItems: "center",
            justifyContent: "center", gap: 4, whiteSpace: "nowrap",
          }}>
            <span style={{ fontSize: 13 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "16px 14px", maxWidth: 700, margin: "0 auto" }}>

        {/* === WORKFLOW === */}
        {tab === "workflow" && (
          <>
            <Card tag="FLOW" title="Reading Checklist">
              <div style={{
                height: 6, borderRadius: 3, background: "#e2e5ea",
                marginBottom: 14, overflow: "hidden",
              }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  background: progress === allCheckItems.length ? "#1a7a3a" : "var(--accent)",
                  width: `${(progress / allCheckItems.length) * 100}%`,
                  transition: "width 0.3s",
                }} />
              </div>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>
                {progress}/{allCheckItems.length} complete
              </div>
              {CHECKLIST.map((group, gi) => {
                const startIdx = CHECKLIST.slice(0, gi).reduce((a, g) => a + g.items.length, 0);
                return (
                  <div key={gi} style={{ marginBottom: 14 }}>
                    <div style={{
                      fontSize: 10, fontWeight: 700, color: "#9ca3af",
                      textTransform: "uppercase", letterSpacing: "0.08em",
                      marginBottom: 6,
                    }}>{group.group}</div>
                    {group.items.map((item, ii) => {
                      const idx = startIdx + ii;
                      const checked = data.checklist[idx];
                      return (
                        <button key={idx} onClick={() => {
                          const next = [...data.checklist];
                          next[idx] = !next[idx];
                          update("checklist", next);
                        }} style={{
                          display: "flex", alignItems: "flex-start", gap: 10,
                          padding: "7px 10px", width: "100%", textAlign: "left",
                          background: checked ? "rgba(74,111,165,0.04)" : "transparent",
                          border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                          borderRadius: 6, cursor: "pointer", marginBottom: 4,
                          transition: "all 0.12s",
                        }}>
                          <span style={{
                            width: 16, height: 16, borderRadius: 3, flexShrink: 0, marginTop: 1,
                            border: `2px solid ${checked ? "var(--accent)" : "#d0d5dd"}`,
                            background: checked ? "var(--accent)" : "#fff",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            color: "#fff", fontSize: 9, fontWeight: 800,
                          }}>{checked && "✓"}</span>
                          <span style={{
                            fontSize: 12, fontWeight: 500,
                            color: checked ? "var(--accent)" : "#4a5568",
                            textDecoration: checked ? "line-through" : "none",
                          }}>{item}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </Card>

            <Card tag="REF" title="Taxonomy Quick Reference">
              {TAXONOMY.map(t => (
                <div key={t.code} style={{
                  display: "flex", gap: 10, padding: "6px 0",
                  borderBottom: "1px solid #f0f1f3",
                }}>
                  <code style={{
                    fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
                    color: "var(--accent)", minWidth: 72,
                  }}>{t.code}</code>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>{t.desc}</span>
                </div>
              ))}
            </Card>

            <Card tag="TIP" title="Key Distinctions">
              {[
                ["VERIFY vs FALSE", "VERIFY = didn't check. FALSE = claimed it worked when it didn't"],
                ["TOOL vs HALLUC", "TOOL = used a real tool wrong. HALLUC = invented non-existent function"],
                ["LAZY vs ROOT", "LAZY = gave up / left placeholders. ROOT = finished but fixed symptoms"],
                ["OVERENG vs FILE", "OVERENG = beyond scope. FILE = wrong files modified/created"],
              ].map(([pair, desc]) => (
                <div key={pair} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "1px solid #f0f1f3" }}>
                  <code style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, color: "#c44", minWidth: 110 }}>{pair}</code>
                  <span style={{ fontSize: 12, color: "#4a5568" }}>{desc}</span>
                </div>
              ))}
            </Card>
          </>
        )}

        {/* === RESPONSE A === */}
        {tab === "a" && (
          <>
            <Card tag="A" title="Scratch Notes" actions={
              <SmallBtn onClick={() => update("notesA", "")}>Clear</SmallBtn>
            }>
              <textarea value={data.notesA} onChange={e => update("notesA", e.target.value)}
                placeholder={"Files edited:\n• \n\nTool calls (str_replace, bash, create_file):\n• \n\nCompletes task? Y/N\nFinal code correct? Y/N\nEdge cases?"}
                style={{
                  width: "100%", minHeight: 180, padding: 12, borderRadius: 8,
                  border: "1px solid var(--border)", background: "#f9fafb",
                  fontSize: 12, fontFamily: "var(--mono)", resize: "vertical",
                  boxSizing: "border-box", lineHeight: 1.7, color: "#1a1a2e",
                }}
              />
            </Card>
            <Card tag="A" title="Strengths" actions={<CharBadge len={data.strengthA.length} min={200} />}>
              <textarea value={data.strengthA} onChange={e => update("strengthA", e.target.value)}
                placeholder="What did A do well? Reference actual tool calls, file names, code changes..."
                style={{
                  width: "100%", minHeight: 120, padding: 12, borderRadius: 8,
                  border: "1px solid var(--border)", background: "#f9fafb",
                  fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6,
                  color: "#1a1a2e",
                }}
              />
            </Card>
            <Card tag="A" title="Weaknesses">
              <WeaknessSelector weaknesses={data.weakA} setWeaknesses={v => update("weakA", v)} />
            </Card>
          </>
        )}

        {/* === RESPONSE B === */}
        {tab === "b" && (
          <>
            <Card tag="B" title="Scratch Notes" actions={
              <SmallBtn onClick={() => update("notesB", "")}>Clear</SmallBtn>
            }>
              <textarea value={data.notesB} onChange={e => update("notesB", e.target.value)}
                placeholder={"Files edited:\n• \n\nTool calls (str_replace, bash, create_file):\n• \n\nCompletes task? Y/N\nFinal code correct? Y/N\nEdge cases?"}
                style={{
                  width: "100%", minHeight: 180, padding: 12, borderRadius: 8,
                  border: "1px solid var(--border)", background: "#f9fafb",
                  fontSize: 12, fontFamily: "var(--mono)", resize: "vertical",
                  boxSizing: "border-box", lineHeight: 1.7, color: "#1a1a2e",
                }}
              />
            </Card>
            <Card tag="B" title="Strengths" actions={<CharBadge len={data.strengthB.length} min={200} />}>
              <textarea value={data.strengthB} onChange={e => update("strengthB", e.target.value)}
                placeholder="What did B do well? Reference actual tool calls, file names, code changes..."
                style={{
                  width: "100%", minHeight: 120, padding: 12, borderRadius: 8,
                  border: "1px solid var(--border)", background: "#f9fafb",
                  fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6,
                  color: "#1a1a2e",
                }}
              />
            </Card>
            <Card tag="B" title="Weaknesses">
              <WeaknessSelector weaknesses={data.weakB} setWeaknesses={v => update("weakB", v)} />
            </Card>
          </>
        )}

        {/* === RATE === */}
        {tab === "rate" && (
          <>
            <Card tag="⚖" title="Overall Preference (0–7)">
              <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 12px" }}>
                Correctness &gt; Efficiency &gt; Process. Match degree to the actual gap.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {SCALE.map(s => (
                  <button key={s.val} onClick={() => update("rating", s.val)} style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 14px", borderRadius: 8,
                    border: data.rating === s.val ? `2px solid ${s.color}` : "1px solid var(--border)",
                    background: data.rating === s.val ? s.bg : "#fff",
                    cursor: "pointer", transition: "all 0.12s",
                  }}>
                    <span style={{
                      width: 28, height: 28, borderRadius: "50%",
                      background: data.rating === s.val ? s.color : "#e2e5ea",
                      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 13, fontWeight: 700, fontFamily: "var(--mono)",
                    }}>{s.val}</span>
                    <span style={{
                      fontSize: 13,
                      fontWeight: data.rating === s.val ? 700 : 500,
                      color: data.rating === s.val ? s.color : "#4a5568",
                    }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </Card>
            <Card tag="✎" title="Rationale" actions={
              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                {data.rationale.split(/\s+/).filter(Boolean).length} words
              </span>
            }>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px" }}>
                Single paragraph. Key differences. Specific evidence. Must match rating direction.
              </p>
              <textarea value={data.rationale} onChange={e => update("rationale", e.target.value)}
                placeholder="Both models fix... but A/B handles... The key difference is..."
                style={{
                  width: "100%", minHeight: 140, padding: 12, borderRadius: 8,
                  border: "1px solid var(--border)", background: "#f9fafb",
                  fontSize: 13, resize: "vertical", boxSizing: "border-box", lineHeight: 1.6,
                  color: "#1a1a2e",
                }}
              />
            </Card>
          </>
        )}

        {/* === CHECK === */}
        {tab === "check" && (
          <>
            <Card tag={errors.length === 0 ? "✓" : "✗"} title="Validation">
              {errors.length === 0 ? (
                <div style={{
                  padding: 24, textAlign: "center", borderRadius: 8,
                  background: "#e8f5ee", border: "1px solid #c5e8d0",
                }}>
                  <div style={{ fontSize: 36, marginBottom: 8 }}>✓</div>
                  <div style={{ fontWeight: 700, color: "#1a7a3a", fontSize: 15 }}>All checks pass</div>
                  <div style={{ fontSize: 12, color: "#4a8a5a", marginTop: 4 }}>Ready to submit.</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {errors.map((e, i) => (
                    <div key={i} style={{
                      padding: "8px 12px", borderRadius: 6,
                      background: e.startsWith("⚠") ? "#fef8e8" : "#fef2f0",
                      border: `1px solid ${e.startsWith("⚠") ? "#f0e0a0" : "#f5d5d0"}`,
                      fontSize: 12, fontWeight: 500,
                      color: e.startsWith("⚠") ? "#8a6a10" : "#c44",
                    }}>✗ {e}</div>
                  ))}
                </div>
              )}
            </Card>

            {symmetryWarns.length > 0 && (
              <Card tag="⚠" title="Symmetry Warnings">
                {symmetryWarns.map((w, i) => (
                  <div key={i} style={{
                    padding: "8px 12px", borderRadius: 6, marginBottom: 4,
                    background: "#fef8e8", border: "1px solid #f0e0a0",
                    fontSize: 12, color: "#8a6a10", fontWeight: 500,
                  }}>⚠ {w} — double-check this is intentional</div>
                ))}
              </Card>
            )}

            <Card tag="📋" title="Summary">
              <div style={{ fontSize: 12, fontFamily: "var(--mono)", lineHeight: 2, color: "#4a5568" }}>
                <div><strong>Task:</strong> {data.taskId || "—"}</div>
                <div><strong>Rating:</strong> {data.rating !== null ? <span style={{ color: SCALE[data.rating].color, fontWeight: 700 }}>{data.rating} — {SCALE[data.rating].label}</span> : "Not set"}</div>
                <div><strong>Strength A:</strong> {data.strengthA.length} chars {data.strengthA.length >= 200 ? "✓" : "✗"}</div>
                <div><strong>Strength B:</strong> {data.strengthB.length} chars {data.strengthB.length >= 200 ? "✓" : "✗"}</div>
                <div><strong>Weaknesses A:</strong> {data.weakA.length > 0 ? data.weakA.map(w => w.code).join(", ") : "None"}</div>
                <div><strong>Weaknesses B:</strong> {data.weakB.length > 0 ? data.weakB.map(w => w.code).join(", ") : "None"}</div>
                <div><strong>Rationale:</strong> {data.rationale.split(/\s+/).filter(Boolean).length} words</div>
              </div>
            </Card>
          </>
        )}

        {/* === HISTORY === */}
        {tab === "history" && (
          <Card tag="⏱" title={`Past Evaluations (${history.length})`}>
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
                        <span style={{
                          marginLeft: 8, fontSize: 11, fontWeight: 700,
                          color: SCALE[h.rating].color,
                        }}>{h.ratingLabel}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      {new Date(h.savedAt).toLocaleDateString()} {new Date(h.savedAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <SmallBtn onClick={() => remove(i)} variant="danger">Remove</SmallBtn>
                </div>
              ))
            )}
          </Card>
        )}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(-8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        * { -webkit-tap-highlight-color: transparent; }
        textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #d0d5dd; border-radius: 3px; }
      `}</style>
    </div>
  );
}
