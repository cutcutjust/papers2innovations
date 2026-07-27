import type { ContextDraft, LibraryPaper } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Layers3, Minus, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { addPaperToContext, clearContext, getContextDraft, removePaperFromContext } from "../lib/bridge";
import { useWorkspace } from "../store";

const totalTokens = (draft: ContextDraft | undefined) => draft
  ? Object.values(draft.tokenBreakdown).reduce((total, value) => total + value, 0)
  : 0;

export function ContextWorkspace({ papers, root }: { papers: LibraryPaper[]; root: string }) {
  const { customModels } = useWorkspace();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [busyPaper, setBusyPaper] = useState("");
  const [error, setError] = useState("");
  const contextQuery = useQuery({
    queryKey: ["context-draft", root],
    queryFn: () => getContextDraft(root),
    retry: false,
  });
  const draft = contextQuery.data;
  const itemsByPaper = useMemo(() => new Map(papers.map((paper) => [
    paper.id,
    draft?.items.filter((item) => item.paperId === paper.id) ?? [],
  ])), [draft?.items, papers]);
  const visiblePapers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? papers.filter((paper) => paper.title.toLowerCase().includes(needle)) : papers;
  }, [filter, papers]);
  const tokenUse = totalTokens(draft);
  const maxContext = customModels[0]?.maxContextTokens ?? 128000;
  const percent = Math.min(100, Math.round(tokenUse / maxContext * 100));
  const includedPaperIds = new Set(draft?.items.map((item) => item.paperId) ?? []);

  const update = async (paperId: string, action: () => Promise<ContextDraft>) => {
    setBusyPaper(paperId);
    setError("");
    try {
      const result = await action();
      queryClient.setQueryData(["context-draft", root], result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyPaper("");
    }
  };

  const addNextPaper = () => {
    const paper = papers.find((item) => !includedPaperIds.has(item.id));
    if (paper) void update(paper.id, () => addPaperToContext(root, paper.id, "full"));
  };

  return <div className="context-page">
    <header className="figma-page-header"><div><h1>Context Workspace</h1><p>Assemble and inspect exactly what your AI agents receive</p></div><div className="page-actions"><button className="secondary-button" disabled={!draft?.items.length || Boolean(busyPaper)} onClick={() => void update("clear", () => clearContext(root))}><Trash2 size={13} /> Clear</button><button className="primary-button compact" disabled={includedPaperIds.size === papers.length || Boolean(busyPaper)} onClick={addNextPaper}><Plus size={13} /> Add paper</button></div></header>
    {error && <div className="settings-status"><TriangleAlert size={15} /> {error}</div>}
    <div className="context-overview"><div><span>Current context</span><strong>{(tokenUse / 1000).toFixed(1)}K <small>/ {(maxContext / 1000).toFixed(0)}K tokens</small></strong><div className="context-track"><i style={{ width: `${percent}%` }} /></div></div><dl><div><dt>Papers</dt><dd>{includedPaperIds.size}</dd></div><div><dt>Capacity used</dt><dd>{percent}%</dd></div><div><dt>Output reserve</dt><dd>{((draft?.tokenBreakdown.outputReserve ?? 16000) / 1000).toFixed(0)}K</dd></div><div><dt>Safety buffer</dt><dd>{((draft?.tokenBreakdown.safetyBuffer ?? 8000) / 1000).toFixed(0)}K</dd></div></dl></div>
    <div className="context-layout"><section className="context-paper-panel"><header><div><h2>Paper sources</h2><p>Persist full papers or selected Reader sections with exact provenance</p></div><label><Search size={12} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter sources" /></label></header><div className="context-paper-rows">{visiblePapers.map((paper) => {
      const items = itemsByPaper.get(paper.id) ?? [];
      const enabled = items.length > 0;
      const paperItem = items.find((item) => !item.sectionId && !item.blockId);
      const mode = paperItem?.mode ?? (enabled ? "sections" : "full");
      const paperTokens = items.reduce((total, item) => total + item.estimatedTokens, 0);
      const busy = busyPaper === paper.id;
      return <article className={!enabled ? "excluded" : ""} key={paper.id}><button className="context-toggle" disabled={busy} onClick={() => void update(paper.id, () => enabled ? removePaperFromContext(root, paper.id) : addPaperToContext(root, paper.id, "full"))}>{enabled ? <Minus size={12} /> : <Plus size={12} />}</button><span className="context-file-icon"><FileText size={15} /></span><div className="context-paper-copy"><h3>{paper.title}</h3><p>{paper.pageCount || "—"} pages · {paper.status} · {items.length} context item{items.length === 1 ? "" : "s"}</p><div className="context-mode-switch"><button className={mode === "full" ? "active" : ""} disabled={busy} onClick={() => void update(paper.id, () => addPaperToContext(root, paper.id, "full"))}>Original text</button><button className={mode === "structured" ? "active" : ""} disabled={busy} onClick={() => void update(paper.id, () => addPaperToContext(root, paper.id, "structured"))}>Structured document</button>{mode === "sections" && <span className="tag tag-ai">Reader selections</span>}</div></div><code>{enabled ? `${(paperTokens / 1000).toFixed(1)}K` : "Excluded"}</code></article>;
    })}</div></section><aside className="context-breakdown"><h2>Token breakdown</h2>{[
      ["System prompt", draft?.tokenBreakdown.systemPrompt ?? 4200],
      ["Agent tools", draft?.tokenBreakdown.tools ?? 7800],
      ["Conversation", draft?.tokenBreakdown.conversation ?? 0],
      ["Paper context", draft?.tokenBreakdown.papers ?? 0],
      ["Output reserve", draft?.tokenBreakdown.outputReserve ?? 16000],
      ["Safety buffer", draft?.tokenBreakdown.safetyBuffer ?? 8000],
    ].map(([label, value]) => <div className="breakdown-row" key={String(label)}><span>{label}</span><b>{(Number(value) / 1000).toFixed(1)}K</b><i><em style={{ width: `${Math.min(100, Number(value) / maxContext * 100)}%` }} /></i></div>)}<div className="context-policy"><Layers3 size={15} /><div><strong>Transparent assembly</strong><p>Every entry keeps its paper hash and optional section or block anchor. Context survives application restarts.</p></div></div></aside></div>
  </div>;
}
