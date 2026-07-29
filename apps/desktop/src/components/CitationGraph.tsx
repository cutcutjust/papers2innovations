import type { CitationGraphNode, CitationGraphResult, LibraryPaper } from "@p2i/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Core } from "cytoscape";
import { BookOpen, CheckCircle2, CircleDot, FileQuestion, Focus, Layers3, LocateFixed, Network, RefreshCw, Search, TriangleAlert, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addPaperToContext, buildCitationGraph } from "../lib/bridge";
import { useWorkspace } from "../store";

const relationLabel: Record<string, string> = {
  cites: "引用",
  shared_reference: "共享参考文献",
  coauthor: "共同作者",
  topic_similarity: "主题相似",
  mutual_citation: "相互引用",
};

const depthLabel = (node: CitationGraphNode) => node.depth === 0 ? "中心论文" : node.depth === 1 ? "直接引用" : "二级引用";
const resolutionLabel = (node: CitationGraphNode) => node.resolved ? "已关联本地论文" : "仅参考文献信息";
const shortTitle = (value: string, length = 34) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

type DepthFilter = "all" | "direct" | "second";
type ResolutionFilter = "all" | "local" | "unresolved";

function highlightGraphSelection(cy: Core, nodeId: string) {
  cy.elements().removeClass("dimmed neighbor highlighted");
  cy.nodes().unselect();
  const node = cy.getElementById(nodeId);
  if (!node.length) return;
  node.select();
  const neighborhood = node.closedNeighborhood();
  cy.elements().not(neighborhood).addClass("dimmed");
  node.neighborhood("node").addClass("neighbor");
  node.connectedEdges().addClass("highlighted");
}

export function CitationGraph({ papers, rootPaper, root }: { papers: LibraryPaper[]; rootPaper?: LibraryPaper; root: string }) {
  const { selectedPaperId, selectPaper, openReader } = useWorkspace();
  const queryClient = useQueryClient();
  const selectedRoot = rootPaper ?? papers[0];
  const [selectedId, setSelectedId] = useState("");
  const [depthFilter, setDepthFilter] = useState<DepthFilter>("all");
  const [resolutionFilter, setResolutionFilter] = useState<ResolutionFilter>("all");
  const [query, setQuery] = useState("");
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
          ...graph.nodes.map((node) => ({ data: { ...node, shortLabel: shortTitle(node.title) } })),
          ...graph.edges.map((edge) => ({ data: { ...edge, label: relationLabel[edge.relation] ?? edge.relation } })),
        ],
        style: [
          {
            selector: "node",
            style: {
              width: "mapData(degree, 0, 12, 16, 34)",
              height: "mapData(degree, 0, 12, 16, 34)",
              "background-color": "#ffffff",
              "border-width": 2,
              "border-color": "#7b8797",
              label: "",
              color: "#273244",
              "font-family": "Segoe UI, sans-serif",
              "font-size": "9px",
              "font-weight": 600,
              "text-max-width": "128px",
              "text-wrap": "ellipsis",
              "text-valign": "bottom",
              "text-margin-y": 8,
              "transition-property": "opacity, border-width, border-color, background-color",
              "transition-duration": 150,
            },
          },
          { selector: "node[depth = 0]", style: { label: "data(shortLabel)", width: 48, height: 48, "border-width": 4, "border-color": "#315fd5", "background-color": "#e8efff", "font-size": "10px", "font-weight": 700 } },
          { selector: "node[depth = 1][resolved]", style: { "border-color": "#23805c", "background-color": "#e7f4ed" } },
          { selector: "node[depth = 1][!resolved]", style: { "border-color": "#a87620", "background-color": "#fff7e4" } },
          { selector: "node[depth = 2][resolved]", style: { "border-color": "#458098", "background-color": "#eaf3f6" } },
          { selector: "node[depth = 2][!resolved]", style: { "border-style": "dashed", "border-color": "#8791a0", "background-color": "#f4f6f8" } },
          { selector: "node:selected", style: { label: "data(shortLabel)", "border-width": 4, "border-color": "#315fd5", "background-color": "#eef2ff", "z-index": 10 } },
          { selector: "node.neighbor", style: { label: "data(shortLabel)", "z-index": 8 } },
          { selector: ".dimmed", style: { opacity: 0.13 } },
          { selector: "edge", style: { width: "mapData(weight, 1, 8, 1, 3)", "line-color": "#9ba7b5", "target-arrow-color": "#9ba7b5", "target-arrow-shape": "triangle", "arrow-scale": 0.62, "curve-style": "straight", opacity: 0.2 } },
          { selector: "edge[relation != 'cites']", style: { "line-style": "dashed", "target-arrow-shape": "none", "line-color": "#5f7e91" } },
          { selector: "edge.highlighted", style: { width: 2.5, "line-color": "#315fd5", "target-arrow-color": "#315fd5", opacity: 0.86, "z-index": 9 } },
        ],
        layout: {
          name: "concentric",
          animate: false,
          fit: true,
          padding: 72,
          startAngle: -Math.PI / 2,
          clockwise: true,
          equidistant: false,
          minNodeSpacing: 36,
          concentric: (node) => 3 - Number(node.data("depth") ?? 2),
          levelWidth: () => 1,
        },
        minZoom: 0.35,
        maxZoom: 2.4,
      });
      instance.on("tap", "node", (event) => setSelectedId(String(event.target.id())));
      cyRef.current = instance;
      const rootNode = instance.getElementById(graph.rootPaperId);
      if (rootNode.length) highlightGraphSelection(instance, selectedId || graph.rootPaperId);
    });
    return () => {
      disposed = true;
      instance?.destroy();
      if (cyRef.current === instance) cyRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selected?.id) return;
    highlightGraphSelection(cy, selected.id);
  }, [selected?.id, graph]);

  const directNodes = useMemo(() => graph?.nodes.filter((node) => node.depth === 1) ?? [], [graph]);
  const secondNodes = useMemo(() => graph?.nodes.filter((node) => node.depth === 2) ?? [], [graph]);
  const visibleNodes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (graph?.nodes ?? []).filter((node) => {
      if (node.depth === 0) return false;
      if (depthFilter === "direct" && node.depth !== 1) return false;
      if (depthFilter === "second" && node.depth !== 2) return false;
      if (resolutionFilter === "local" && !node.resolved) return false;
      if (resolutionFilter === "unresolved" && node.resolved) return false;
      return !normalizedQuery || `${node.title} ${node.authors.join(" ")} ${node.year ?? ""}`.toLowerCase().includes(normalizedQuery);
    }).sort((left, right) => right.degree - left.degree || left.title.localeCompare(right.title));
  }, [depthFilter, graph, query, resolutionFilter]);
  const selectedRelations = graph?.edges.filter((edge) => edge.source === selected?.id || edge.target === selected?.id) ?? [];
  const selectedPaper = selected?.paperId ? papers.find((paper) => paper.id === selected.paperId) : undefined;

  const chooseRoot = (paperId: string) => {
    selectPaper(paperId);
    setSelectedId(paperId);
    setForceRevision(0);
  };

  const selectNode = (node: CitationGraphNode) => {
    setSelectedId(node.id);
    const graphNode = cyRef.current?.getElementById(node.id);
    if (graphNode?.length) {
      graphNode.select();
      cyRef.current?.animate({ center: { eles: graphNode }, duration: 180 });
    }
  };

  const addSelectedToContext = async () => {
    if (!selectedPaper) return;
    setContextBusy(true);
    try {
      await addPaperToContext(root, selectedPaper.id, "full");
      await queryClient.invalidateQueries({ queryKey: ["context-draft", root] });
    } finally {
      setContextBusy(false);
    }
  };

  return <div className="citation-page graph-page-modern">
    <header className="graph-toolbar-modern">
      <div className="graph-page-title"><span><Network size={18} /></span><div><strong>引用关系图谱</strong><small>从当前论文出发，追踪直接引用与二级证据来源</small></div></div>
      <label className="graph-root-picker"><Search size={13} /><select aria-label="选择中心论文" value={selectedPaperId ?? selectedRoot?.id ?? ""} onChange={(event) => chooseRoot(event.target.value)}>{papers.map((paper) => <option value={paper.id} key={paper.id}>{paper.title}</option>)}</select></label>
      <button className="primary-button compact" disabled={!selectedRoot || graphQuery.isFetching} onClick={() => setForceRevision((value) => value + 1)}><RefreshCw size={14} className={graphQuery.isFetching ? "spin" : ""} /> {graphQuery.isFetching ? "正在分析" : graph?.cacheHit ? "重新分析" : "分析引用"}</button>
    </header>
    {graphQuery.error && <div className="settings-status error"><TriangleAlert size={14} /> {graphQuery.error instanceof Error ? graphQuery.error.message : String(graphQuery.error)}</div>}
    <div className="graph-layout-modern">
      <aside className="graph-browser-panel">
        <div className="graph-summary-strip"><div><b>{graph?.directCount ?? 0}</b><span>直接引用</span></div><div><b>{graph?.secondLevelCount ?? 0}</b><span>二级引用</span></div><div><b>{graph?.unresolvedCount ?? 0}</b><span>待关联</span></div></div>
        <label className="graph-list-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者或年份" /></label>
        <div className="graph-filter-row" aria-label="引用层级筛选"><button className={depthFilter === "all" ? "active" : ""} onClick={() => setDepthFilter("all")}>全部</button><button className={depthFilter === "direct" ? "active" : ""} onClick={() => setDepthFilter("direct")}>直接 {directNodes.length}</button><button className={depthFilter === "second" ? "active" : ""} onClick={() => setDepthFilter("second")}>二级 {secondNodes.length}</button></div>
        <div className="graph-resolution-row"><button className={resolutionFilter === "all" ? "active" : ""} onClick={() => setResolutionFilter("all")}><CircleDot size={11} /> 全部状态</button><button className={resolutionFilter === "local" ? "active" : ""} onClick={() => setResolutionFilter("local")}><CheckCircle2 size={11} /> 本地</button><button className={resolutionFilter === "unresolved" ? "active" : ""} onClick={() => setResolutionFilter("unresolved")}><FileQuestion size={11} /> 待关联</button></div>
        <div className="graph-reference-list-modern">{visibleNodes.length ? visibleNodes.map((node) => <GraphListItem key={node.id} node={node} selected={selected?.id === node.id} onSelect={() => selectNode(node)} />) : <div className="graph-empty"><Search size={22} /><p>{graphQuery.isFetching ? "正在提取结构化参考文献…" : "没有符合当前筛选条件的引用。"}</p></div>}</div>
      </aside>
      <main className="graph-canvas-modern">
        <div className="graph-canvas-heading"><div><strong>{selectedRoot?.title ? shortTitle(selectedRoot.title, 52) : "局部引用网络"}</strong><span>{graph?.nodes.length ?? 0} 个节点 · {graph?.edges.length ?? 0} 条关系</span></div><div className="graph-status-legend"><span><i className="root" />中心</span><span><i className="local" />本地论文</span><span><i className="reference" />参考文献</span><span><i className="second" />二级</span></div></div>
        <div className="cytoscape-host" ref={canvasRef} />
        {graphQuery.isFetching && <div className="graph-loading-overlay"><RefreshCw className="spin" size={20} /><span>正在整理引用关系</span></div>}
        <div className="graph-controls-modern"><button title="缩小" aria-label="缩小" onClick={() => { const cy = cyRef.current; if (cy) cy.zoom(Math.max(cy.minZoom(), cy.zoom() - 0.18)); }}><ZoomOut size={15} /></button><button title="适应画布" aria-label="适应画布" onClick={() => cyRef.current?.fit(undefined, 72)}><Focus size={15} /></button><button title="回到中心论文" aria-label="回到中心论文" onClick={() => { const node = cyRef.current?.getElementById(graph?.rootPaperId ?? ""); if (node?.length) { setSelectedId(String(node.id())); cyRef.current?.animate({ center: { eles: node }, zoom: 1, duration: 220 }); } }}><LocateFixed size={15} /></button><button title="放大" aria-label="放大" onClick={() => { const cy = cyRef.current; if (cy) cy.zoom(Math.min(cy.maxZoom(), cy.zoom() + 0.18)); }}><ZoomIn size={15} /></button></div>
      </main>
      <aside className="graph-inspector-modern">
        {selected ? <><header><div className="graph-node-badges"><span className={`depth depth-${selected.depth}`}>{depthLabel(selected)}</span><span className={selected.resolved ? "resolved" : "unresolved"}>{resolutionLabel(selected)}</span></div><h2>{selected.title}</h2><p>{selected.year ?? "年份未知"} · {selected.authors.slice(0, 4).join("、") || "作者信息不可用"}</p></header><section className="graph-provenance"><Network size={15} /><div><b>关系来源</b><p>{selected.depth === 0 ? "当前选定的中心论文。" : selected.depth === 1 ? "出现在中心论文的参考文献中。" : "由一个或多个直接引用节点继续引用。"}</p></div></section><dl className="graph-node-facts"><div><dt>节点连接</dt><dd>{selected.degree}</dd></div><div><dt>当前关系</dt><dd>{selectedRelations.length}</dd></div><div><dt>所在层级</dt><dd>{selected.depth}</dd></div><div><dt>解析状态</dt><dd>{selected.status === "ready" ? "完整" : selected.status === "partial" ? "部分" : selected.status === "error" ? "失败" : "待关联"}</dd></div></dl><section className="graph-relations-modern"><h3>与该节点的关系</h3>{selectedRelations.length ? selectedRelations.slice(0, 8).map((edge) => <div key={edge.id}><span><Network size={11} />{relationLabel[edge.relation] ?? edge.relation}</span><b>权重 {edge.weight}</b></div>) : <p>暂无可展示的直接关系。</p>}</section>{selected.depth === 2 && <div className="graph-depth-note"><TriangleAlert size={14} /><span>当前分析止于二级引用，避免网络无限扩张。</span></div>}<footer><button className="primary-button compact" disabled={!selectedPaper} onClick={() => selectedPaper && openReader(selectedPaper.id)}><BookOpen size={13} /> 打开论文</button><button className="secondary-button" disabled={!selectedPaper || contextBusy} onClick={() => void addSelectedToContext()}><Layers3 size={13} /> 加入研究上下文</button>{selectedPaper && selectedPaper.id !== selectedRoot?.id && <button className="secondary-button" onClick={() => chooseRoot(selectedPaper.id)}><LocateFixed size={13} /> 设为中心论文</button>}</footer></> : <div className="graph-empty"><Network size={25} /><p>选择一个节点查看引用来源与本地关联。</p></div>}
      </aside>
    </div>
  </div>;
}

function GraphListItem({ node, selected, onSelect }: { node: CitationGraphNode; selected: boolean; onSelect: () => void }) {
  return <button className={selected ? "active" : ""} onClick={onSelect}><span className={`graph-list-node depth-${node.depth} ${node.resolved ? "resolved" : "unresolved"}`}><i /></span><span><strong>{node.title}</strong><small>{node.year ?? "年份未知"} · {node.authors[0] || resolutionLabel(node)}</small></span><b>{node.degree}</b></button>;
}
