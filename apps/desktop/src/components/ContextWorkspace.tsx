import type { LibraryPaper } from "@p2i/contracts";
import { FileText, Layers3, Minus, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useWorkspace } from "../store";

export function ContextWorkspace({ papers }: { papers: LibraryPaper[] }) {
  const { customModels } = useWorkspace();
  const [included, setIncluded] = useState<Record<string, boolean>>(() => Object.fromEntries(papers.slice(0, 3).map((paper) => [paper.id, true])));
  const [modes, setModes] = useState<Record<string, "full" | "summary">>({});
  const tokenUse = useMemo(() => papers.reduce((total, paper, index) => {
    if (!included[paper.id]) return total;
    return total + (modes[paper.id] === "summary" ? 3200 : Math.max(6000, (paper.pageCount || 10) * 680 + index * 300));
  }, 0), [papers, included, modes]);
  const percent = Math.min(100, Math.round(tokenUse / 128000 * 100));
  return <div className="context-page">
    <header className="figma-page-header"><div><h1>Context Workspace</h1><p>Assemble and inspect exactly what your AI agents receive</p></div><div className="page-actions"><button className="secondary-button"><Trash2 size={13} /> Clear</button><button className="primary-button compact"><Plus size={13} /> Add papers</button></div></header>
    <div className="context-overview"><div><span>Current context</span><strong>{(tokenUse / 1000).toFixed(1)}K <small>/ 128K tokens</small></strong><div className="context-track"><i style={{ width: `${percent}%` }} /></div></div><dl><div><dt>Papers</dt><dd>{Object.values(included).filter(Boolean).length}</dd></div><div><dt>Capacity used</dt><dd>{percent}%</dd></div><div><dt>Output reserve</dt><dd>16K</dd></div><div><dt>Safety buffer</dt><dd>8K</dd></div></dl></div>
    <div className="context-layout"><section className="context-paper-panel"><header><div><h2>Paper sources</h2><p>Choose full original text or AI-compressed context per paper</p></div><label><Search size={12} /><input placeholder="Filter sources" /></label></header><div className="context-paper-rows">{papers.map((paper, index) => {
      const enabled = Boolean(included[paper.id]); const mode = modes[paper.id] ?? (index ? "summary" : "full");
      return <article className={!enabled ? "excluded" : ""} key={paper.id}><button className="context-toggle" onClick={() => setIncluded((state) => ({ ...state, [paper.id]: !enabled }))}>{enabled ? <Minus size={12} /> : <Plus size={12} />}</button><span className="context-file-icon"><FileText size={15} /></span><div className="context-paper-copy"><h3>{paper.title}</h3><p>{paper.pageCount || "—"} pages · {paper.status} · Local paper</p><div className="context-mode-switch"><button className={mode === "full" ? "active" : ""} onClick={() => { setIncluded((state) => ({ ...state, [paper.id]: true })); setModes((state) => ({ ...state, [paper.id]: "full" })); }}>Original text</button><button className={mode === "summary" ? "active" : ""} onClick={() => { setIncluded((state) => ({ ...state, [paper.id]: true })); setModes((state) => ({ ...state, [paper.id]: "summary" })); }}>AI compressed</button></div>{mode === "summary" && enabled && <label className="context-compression-model"><span>Compression model</span><select>{customModels.map((model) => <option key={model.id}>{model.name} · {model.format}</option>)}</select></label>}</div><code>{enabled ? mode === "summary" ? "3.2K" : `${Math.max(6, (paper.pageCount || 10) * .68).toFixed(1)}K` : "Excluded"}</code></article>;
    })}</div></section><aside className="context-breakdown"><h2>Token breakdown</h2>{[["System prompt", 4200], ["Agent tools", 7800], ["Conversation", 12400], ["Paper context", tokenUse], ["Output reserve", 16000], ["Safety buffer", 8000]].map(([label, value]) => <div className="breakdown-row" key={String(label)}><span>{label}</span><b>{(Number(value) / 1000).toFixed(1)}K</b><i><em style={{ width: `${Math.min(100, Number(value) / 1280)}%` }} /></i></div>)}<div className="context-policy"><Layers3 size={15} /><div><strong>Transparent assembly</strong><p>Original text is never rewritten. Compressed entries keep their source paper and section references.</p></div></div></aside></div>
  </div>;
}
