import type { CitationGraphNode, CitationGraphResult, LibraryPaper } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Core } from "cytoscape";
import { BookOpen, FileText, Layers3, Network, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addPaperToContext, buildCitationGraph } from "../lib/bridge";
import { useWorkspace } from "../store";

const relationLabel: Record<string, string> = {
  cites: "Citation",
  shared_reference: "Shared references",
  coauthor: "Common authors",
  topic_similarity: "Topic similarity",
  mutual_citation: "Mutual citation",
};

export function CitationGraph({ papers, rootPaper, root }: { papers: LibraryPaper[]; rootPaper?: LibraryPaper; root: string }) {
  const { selectedPaperId, selectPaper, openReader } = useWorkspace();
  const queryClient = useQueryClient();
  const selectedRoot = rootPaper ?? papers[0];
  const [selectedId, setSelectedId] = useState("");
  const [depth, setDepth] = useState<1 | 2>(1);
  const [forceRevision, setForceRevision] = useState(0);
  const [contextBusy, setContextBusy] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const graphQuery = useQuery({
    queryKey: ["citation-graph", root, selectedRoot?.id, forceRevision],
    queryFn: () => buildCitationGraph(root, selectedRoot!.id, forceRevision > 0),
    enabled: Boolean(root && selectedRoot?.id),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const graph = graphQuery.data;
  const selected = graph?.nodes.find((node) => node.id === selectedId)
    ?? graph?.nodes.find((node) => node.id === graph.rootPaperId)
    ?? graph?.nodes[0];

  useEffect(() => {
    setSelectedId(selectedRoot?.id ?? "");
  }, [selectedRoot?.id]);

  useEffect(() => {
    if (!canvasRef.current || !graph?.nodes.length) return;
    let disposed = false;
    let instance: Core | undefined;
    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed || !canvasRef.current) return;
      instance = cytoscape({
        container: canvasRef.current,
        elements: [
          ...graph.nodes.map((node) => ({ data: { ...node, label: node.title } })),
          ...graph.edges.map((edge) => ({ data: { ...edge, label: relationLabel[edge.relation] ?? edge.relation } })),
        ],
        style: [
          {
            selector: "node",
            style: {
              width: "mapData(degree, 0, 12, 24, 58)",
              height: "mapData(degree, 0, 12, 24, 58)",
              "background-color": "#ffffff",
              "border-width": "2px",
              "border-color": "#8c9aad",
              label: "data(label)",
              color: "#394150",
              "font-size": "8px",
              "text-max-width": "110px",
              "text-wrap": "ellipsis",
              "text-valign": "bottom",
              "text-margin-y": 8,
            },
          },
          { selector: "node[depth = 0]", style: { "border-color": "#4f6bed", "background-color": "#e9edff", width: "62px", height: "62px", "font-weight": "bold" } },
          { selector: "node[depth = 1]", style: { "border-color": "#7357d8", "background-color": "#f0ecff" } },
          { selector: "node[!resolved]", style: { "border-style": "dashed", "border-color": "#a08b70", "background-color": "#fffaf0" } },
          { selector: "node:selected", style: { "border-width": 4, "border-color": "#4f6bed" } },
          { selector: "edge", style: { width: "mapData(weight, 1, 8, 1, 4)", "line-color": "#aeb8c4", "target-arrow-color": "#aeb8c4", "target-arrow-shape": "triangle", "curve-style": "bezier", opacity: 0.6 } },
          { selector: "edge[relation != 'cites']", style: { "line-style": "dashed", "target-arrow-shape": "none", "line-color": "#7357d8" } },
        ],
        layout: { name: "cose", animate: false, randomize: true, fit: true, padding: 70, nodeRepulsion: () => 6500, idealEdgeLength: () => 95 },
        minZoom: 0.3,
        maxZoom: 2.5,
      });
      instance.on("tap", "node", (event) => setSelectedId(String(event.target.id())));
      cyRef.current = instance;
    });
    return () => {
      disposed = true;
      instance?.destroy();
      if (cyRef.current === instance) cyRef.current = null;
    };
  }, [graph]);

  const directNodes = useMemo(() => graph?.nodes.filter((node) => node.depth === 1) ?? [], [graph]);
  const secondNodes = useMemo(() => graph?.nodes.filter((node) => node.depth === 2) ?? [], [graph]);
  const visibleNodes = depth === 1 ? directNodes : secondNodes;
  const selectedRelations = graph?.edges.filter((edge) => edge.source === selected?.id || edge.target === selected?.id) ?? [];
  const selectedPaper = selected?.paperId ? papers.find((paper) => paper.id === selected.paperId) : undefined;

  const chooseRoot = (paperId: string) => {
    selectPaper(paperId);
    setSelectedId(paperId);
    setForceRevision(0);
  };

  const addSelectedToContext = async () => {
    if (!selectedPaper) return;
    setContextBusy(true);
    try {
      const draft = await addPaperToContext(root, selectedPaper.id, "full");
      queryClient.setQueryData(["context-draft", root], draft);
    } finally {
      setContextBusy(false);
    }
  };

  return <div className="citation-page">
    <div className="graph-toolbar">
      <span>Root paper A</span>
      <label><Search size={12} /><select value={selectedPaperId ?? selectedRoot?.id ?? ""} onChange={(event) => chooseRoot(event.target.value)}>{papers.map((paper) => <option value={paper.id} key={paper.id}>{paper.title}</option>)}</select></label>
      <span className={`tag ${graph?.status === "ready" ? "tag-success" : "tag-warning"}`}>{graphQuery.isLoading ? "Parsing" : graph?.status ?? "Not built"}</span>
      <span className="tag tag-primary">Depth 1 · {graph?.directCount ?? 0}</span>
      <span className="tag tag-ai">Depth 2 · {graph?.secondLevelCount ?? 0}</span>
      <small>{graph?.cacheHit ? "Local graph cache" : "Stops after references of references"}</small>
      <button className="primary-button compact" disabled={!selectedRoot || graphQuery.isFetching} onClick={() => setForceRevision((value) => value + 1)}><RefreshCw size={13} className={graphQuery.isFetching ? "spin" : ""} /> {graphQuery.isFetching ? "Parsing network" : "Analyze citations"}</button>
    </div>
    {graphQuery.error && <div className="settings-status error"><TriangleAlert size={14} /> {graphQuery.error instanceof Error ? graphQuery.error.message : String(graphQuery.error)}</div>}
    <div className="graph-layout">
      <aside className="graph-list-panel">
        <header><span className="tag tag-primary">ROOT A</span><b>{graph?.edges.length ?? 0} local links</b><h2>{selectedRoot?.title ?? "Choose a paper"}</h2><p>Local paper · {selectedRoot?.pageCount || "—"} pages</p><dl><div><dd>{graph?.directCount ?? 0}</dd><dt>Direct refs</dt></div><div><dd>{graph?.secondLevelCount ?? 0}</dd><dt>Second level</dt></div><div><dd>{graph?.unresolvedCount ?? 0}</dd><dt>Unresolved</dt></div></dl></header>
        <div className="graph-depth-tabs"><button className={depth === 1 ? "active" : ""} onClick={() => setDepth(1)}>Direct refs · {directNodes.length}</button><button className={depth === 2 ? "active" : ""} onClick={() => setDepth(2)}>Second level · {secondNodes.length}</button></div>
        <div className="graph-reference-list">{visibleNodes.length ? visibleNodes.map((node) => <GraphListItem key={node.id} node={node} selected={selected?.id === node.id} onSelect={() => { setSelectedId(node.id); cyRef.current?.getElementById(node.id).select(); }} />) : <div className="graph-empty"><FileText size={22} /><p>{graphQuery.isFetching ? "Extracting structured references…" : "No references were extracted at this depth."}</p></div>}</div>
      </aside>
      <main className="graph-canvas"><div className="graph-canvas-title"><strong>Two-level citation network</strong><span>{graph?.edges.length ?? 0} relationships</span></div><div className="graph-legend"><span><i className="root" /> Root A</span><span><i className="direct" /> Direct</span><span><i className="second" /> Second level</span><b>Node size = graph degree</b></div><div className="cytoscape-host" ref={canvasRef} /><div className="graph-controls"><button onClick={() => cyRef.current?.fit(undefined, 45)}>Fit</button><button onClick={() => { const node = cyRef.current?.getElementById(graph?.rootPaperId ?? ""); if (node?.length) { cyRef.current?.center(node); node.select(); } }}>Recenter A</button><button onClick={() => cyRef.current?.zoom(1)}>100%</button></div></main>
      <aside className="graph-inspector">
        {selected ? <><div><span className={`tag ${selected.depth === 0 ? "tag-primary" : selected.depth === 1 ? "tag-ai" : "tag-warning"}`}>{selected.depth === 0 ? "ROOT PAPER A" : `DEPTH ${selected.depth}`}</span><span className={`tag ${selected.resolved ? "tag-success" : "tag-warning"}`}>{selected.resolved ? "Local paper" : "Unresolved"}</span><h2>{selected.title}</h2><p>{selected.year ?? "Year unknown"} · {selected.authors.slice(0, 3).join(", ") || "Authors unavailable"}</p><blockquote><b>Graph provenance</b><br />{selected.depth === 0 ? "Selected root paper A." : selected.depth === 1 ? "Directly cited by paper A." : "Cited by one or more direct references of A."}</blockquote><dl><div><dt>Linked papers</dt><dd>{selected.degree}</dd></div><div><dt>Relations</dt><dd>{selectedRelations.length}</dd></div><div><dt>Graph depth</dt><dd>{selected.depth}</dd></div><div><dt>Resolution</dt><dd>{selected.status}</dd></div></dl></div><section><h3>Relationships</h3>{selectedRelations.slice(0, 6).map((edge) => <p className="graph-relation" key={edge.id}><Network size={11} /><span>{relationLabel[edge.relation]} · weight {edge.weight}</span></p>)}{selected.depth === 2 && <aside className="warning"><Network size={14} /><div><b>Depth limit reached</b><p>Further expansion is disabled. The engine enforces maxDepth 2.</p></div></aside>}</section><footer><button className="primary-button compact" disabled={!selectedPaper} onClick={() => selectedPaper && openReader(selectedPaper.id)}><BookOpen size={13} /> Open paper</button><button className="secondary-button" disabled={!selectedPaper || contextBusy} onClick={() => void addSelectedToContext()}><Layers3 size={13} /> Add to context</button><button className="secondary-button" disabled={selected.depth === 2 || !selected.resolved}><RefreshCw size={13} /> {selected.depth === 2 ? "Expansion disabled at depth 2" : "Inspect references"}</button></footer></> : <div className="graph-empty"><Network size={25} /><p>Build the graph to inspect citation provenance.</p></div>}
      </aside>
    </div>
  </div>;
}

function GraphListItem({ node, selected, onSelect }: { node: CitationGraphNode; selected: boolean; onSelect: () => void }) {
  const color = node.depth === 1 ? "#7357d8" : node.resolved ? "#77989a" : "#a08b70";
  const size = Math.min(16, 8 + node.degree * 1.5);
  return <button className={selected ? "active" : ""} onClick={onSelect}><i style={{ background: color, width: size, height: size }} /><span><strong>{node.title}</strong><small>{node.year ?? "Year unknown"} · {node.resolved ? "Local" : "Unresolved"}</small></span><b>{node.degree} links</b></button>;
}
