import type { LibraryPaper } from "@p2i/contracts";
import { FileText, Plus, RotateCcw, Save, Settings2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../store";

type ContextMode = "original" | "compressed" | "excluded";
type ModelRoute = "compression" | "evidence" | "ideas" | "novelty" | "critique";

const defaultPrompt = [
  "You are a research innovation analyst.",
  "",
  "Using {paper_context}, identify transferable mechanisms, unresolved limitations, and contradictory assumptions across the selected papers.",
  "",
  "Generate 3 testable research ideas. For each idea provide:",
  "1. Research gap and evidence citations",
  "2. Proposed mechanism and why it may work",
  "3. Falsifiable hypothesis",
  "4. Minimum viable experiment",
  "5. Novelty risks and closest known work",
  "",
  "Do not invent evidence. Cite the paper and page or section for every factual claim.",
].join("\n");

const routes: Array<{ id: ModelRoute; label: string; description: string }> = [
  { id: "compression", label: "Context compression", description: "Compress only papers marked AI compressed" },
  { id: "evidence", label: "Evidence extraction", description: "Extract claims, methods, limitations and citations" },
  { id: "ideas", label: "Idea generation", description: "Generate hypotheses from the editable prompt" },
  { id: "novelty", label: "Novelty verification", description: "Compare candidates against local and web sources" },
  { id: "critique", label: "Critique & experiments", description: "Stress-test claims and design minimum experiments" },
];

const defaultRouteModels: Record<ModelRoute, string> = {
  compression: "custom-fast-model",
  evidence: "custom-long-context-model",
  ideas: "custom-chat-model",
  novelty: "custom-reasoning-model",
  critique: "custom-reasoning-model",
};

function paperTokens(paper: LibraryPaper) {
  return Math.max(paper.pageCount || 12, 8) * 900;
}

export function InnovationWorkspace({ papers }: { papers: LibraryPaper[] }) {
  const { customModels, setView } = useWorkspace();
  const contextPapers = useMemo(() => {
    const ready = papers.filter((paper) => paper.status === "READY");
    return (ready.length > 0 ? ready : papers).slice(0, 5);
  }, [papers]);
  const [prompt, setPrompt] = useState(() => localStorage.getItem("p2i.innovationPrompt") ?? defaultPrompt);
  const [paperModes, setPaperModes] = useState<Record<string, ContextMode>>({});
  const [compressionModels, setCompressionModels] = useState<Record<string, string>>({});
  const [routeModels, setRouteModels] = useState<Record<ModelRoute, string>>(defaultRouteModels);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState("Ready");

  const firstModelId = customModels[0]?.id ?? "";

  useEffect(() => {
    setPaperModes((current) => {
      const next = { ...current };
      contextPapers.forEach((paper, index) => {
        if (!next[paper.id]) next[paper.id] = index === 0 ? "original" : "compressed";
      });
      return next;
    });
  }, [contextPapers]);

  useEffect(() => {
    if (!firstModelId) return;
    const available = new Set(customModels.map((model) => model.id));
    setRouteModels((current) => Object.fromEntries(
      routes.map((route) => [route.id, available.has(current[route.id]) ? current[route.id] : firstModelId]),
    ) as Record<ModelRoute, string>);
  }, [customModels, firstModelId]);

  const contextUsed = contextPapers.reduce((total, paper) => {
    const tokens = paperTokens(paper);
    const mode = paperModes[paper.id];
    return total + (mode === "original" ? tokens : mode === "compressed" ? Math.round(tokens * 0.25) : 0);
  }, 0);
  const originalCount = contextPapers.filter((paper) => paperModes[paper.id] === "original").length;
  const compressedCount = contextPapers.filter((paper) => paperModes[paper.id] === "compressed").length;
  const includedCount = originalCount + compressedCount;
  const contextPercent = Math.min(100, Math.round((contextUsed / 128_000) * 100));

  const selectModel = (value: string, label: string, onChange: (model: string) => void) => (
    <select aria-label={label} value={value || firstModelId} onChange={(event) => onChange(event.target.value)}>
      {customModels.map((model) => <option value={model.id} key={model.id}>{model.name} / {model.model}</option>)}
    </select>
  );

  const savePrompt = () => {
    localStorage.setItem("p2i.innovationPrompt", prompt);
    setRunStatus("Prompt preset saved");
  };

  const run = () => {
    if (includedCount === 0 || customModels.length === 0) return;
    setRunning(true);
    setRunStatus("Preparing context snapshot");
    window.setTimeout(() => {
      setRunning(false);
      setRunStatus("Run request prepared");
    }, 900);
  };

  return <main className="innovation-workspace">
    <header className="innovation-header">
      <div className="innovation-title">
        <div><h1>Papers2Innovations</h1><span>Prompt workbench</span></div>
        <p>Edit one prompt, assemble context deliberately, and route every AI stage independently.</p>
      </div>
      <div className="innovation-header-actions">
        <span className="compact-badge">{includedCount} papers</span>
        <span className="compact-badge">{contextPercent}% context</span>
        <button className="secondary-button" onClick={() => setView("settings")}><Settings2 size={14} /> Model settings</button>
        <button className="primary-button compact" onClick={run} disabled={running || includedCount === 0 || customModels.length === 0}><Sparkles size={14} /> {running ? "Preparing" : "Run synthesis"}</button>
      </div>
    </header>

    <div className="innovation-layout">
      <aside className="context-panel">
        <div className="context-panel-heading"><div><strong>Paper context</strong><span>Choose how each paper enters this run</span></div><button className="icon-button small" title="Add papers"><Plus size={15} /></button></div>
        <div className="context-meter">
          <div className="context-meter-label"><span>Current run context</span><strong>{(contextUsed / 1000).toFixed(1)}K / 128K</strong></div>
          <div className="context-meter-track"><i style={{ width: `${contextPercent}%` }} /></div>
          <div className="context-meter-meta"><span>{(contextUsed / 1000).toFixed(1)}K tokens</span><span>{contextPercent}% used</span></div>
        </div>
        <div className="context-paper-list">
          {contextPapers.map((paper, index) => {
            const mode = paperModes[paper.id] ?? "excluded";
            const fullTokens = paperTokens(paper);
            const compressionModel = compressionModels[paper.id] || routeModels.compression || firstModelId;
            return <section className={`context-paper ${mode === "excluded" ? "excluded" : ""}`} key={paper.id}>
              <div className="context-paper-title">
                <input type="checkbox" checked={mode !== "excluded"} onChange={() => setPaperModes({ ...paperModes, [paper.id]: mode === "excluded" ? "original" : "excluded" })} aria-label={`Include ${paper.title}`} />
                <span><strong>{paper.title}</strong><small>{paper.pageCount || "--"} pages / {paper.status.toLowerCase()}</small></span>
                {index === 0 && <b>Core</b>}
              </div>
              <div className="context-mode-control">
                <button className={mode === "original" ? "active" : ""} onClick={() => setPaperModes({ ...paperModes, [paper.id]: "original" })}>Original</button>
                <button className={mode === "compressed" ? "active" : ""} onClick={() => setPaperModes({ ...paperModes, [paper.id]: "compressed" })}>AI compressed</button>
              </div>
              {mode === "original" && <div className="context-mode-note"><FileText size={12} /> Full paper / {(fullTokens / 1000).toFixed(1)}K tokens</div>}
              {mode === "compressed" && <label className="context-model-select"><span>Compression model <small>{(fullTokens * 0.25 / 1000).toFixed(1)}K tokens</small></span>{selectModel(compressionModel, `Compression model for ${paper.title}`, (model) => setCompressionModels({ ...compressionModels, [paper.id]: model }))}</label>}
              {mode === "excluded" && <div className="context-excluded">Excluded from this run</div>}
            </section>;
          })}
          {contextPapers.length === 0 && <div className="context-empty"><FileText size={24} /><span>No parsed papers are available.</span></div>}
        </div>
        <div className="context-panel-footer"><span>Original text is never rewritten</span><button onClick={() => setPaperModes(Object.fromEntries(contextPapers.map((paper) => [paper.id, "excluded"])))}>Clear all</button></div>
      </aside>

      <div className="innovation-main-scroll">
        <div className="innovation-content">
          <section className="workbench-panel prompt-panel">
            <div className="workbench-panel-heading">
              <div><h2>Synthesis prompt</h2><p>This exact text is sent to the idea generation stage.</p></div>
              <label className="inline-model-select"><span>Idea model</span>{selectModel(routeModels.ideas, "Idea generation model", (model) => setRouteModels({ ...routeModels, ideas: model }))}</label>
            </div>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} aria-label="Synthesis prompt" />
            <div className="prompt-footer"><code>{"{paper_context}"}</code><span>Resolves to {includedCount} selected papers at run time</span><div><small>{prompt.length} characters</small><button onClick={() => setPrompt(defaultPrompt)}><RotateCcw size={12} /> Reset</button><button onClick={savePrompt}><Save size={12} /> Save preset</button></div></div>
          </section>

          <section className="workbench-panel context-summary-panel">
            <div className="workbench-panel-heading"><div><h2>Context assembly</h2><p>A transparent preview of what the run receives.</p></div><span className="agent-badge">{(contextUsed / 1000).toFixed(1)}K / 128K</span></div>
            <div className="context-summary-grid">
              <div><span>Full paper text</span><strong>{originalCount}</strong><small>Added verbatim</small></div>
              <div><span>AI compressed</span><strong>{compressedCount}</strong><small>Per-paper model choice</small></div>
              <div><span>Capacity remaining</span><strong>{((128_000 - contextUsed) / 1000).toFixed(1)}K</strong><small>Before output reserve</small></div>
            </div>
          </section>

          <section className="workbench-panel model-routing-panel">
            <div className="workbench-panel-heading"><div><h2>AI processing stages</h2><p>Each stage can use a different custom model.</p></div><button className="secondary-button" onClick={() => setView("settings")}><Settings2 size={13} /> Manage models</button></div>
            <div className="route-list">
              {routes.map((route, index) => {
                const model = customModels.find((item) => item.id === routeModels[route.id]);
                return <div className="route-row" key={route.id}>
                  <span className="route-number">{index + 1}</span>
                  <span className="route-copy"><strong>{route.label}<b>{model?.format === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</b></strong><small>{route.description}</small></span>
                  {selectModel(routeModels[route.id], `${route.label} model`, (selectedModel) => setRouteModels({ ...routeModels, [route.id]: selectedModel }))}
                </div>;
              })}
            </div>
          </section>

          <div className="innovation-run-bar"><div><strong>{runStatus}</strong><span>{includedCount} papers / {(contextUsed / 1000).toFixed(1)}K context tokens / 5 AI stages</span></div><div><button className="secondary-button" onClick={savePrompt}><Save size={13} /> Save template</button><button className="primary-button compact" onClick={run} disabled={running || includedCount === 0 || customModels.length === 0}><Sparkles size={14} /> {running ? "Preparing" : "Run synthesis"}</button></div></div>
        </div>
      </div>
    </div>
  </main>;
}
