import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ZoteroImportCandidate } from "@p2i/contracts";
import { AlertTriangle, CheckCircle2, Database, FileInput, FolderTree, ListFilter, LoaderCircle, RefreshCw } from "lucide-react";
import { getOcrStatus, importFromZotero, inspectZotero, previewZoteroImport } from "../lib/bridge";

export function ZoteroImport({ root }: { root: string }) {
  const queryClient = useQueryClient();
  const inspection = useQuery({ queryKey: ["zotero-inspection"], queryFn: inspectZotero, retry: false });
  const ocrStatus = useQuery({ queryKey: ["ocr-status"], queryFn: getOcrStatus, retry: false });
  const preview = useQuery({ queryKey: ["zotero-preview"], queryFn: previewZoteroImport, enabled: Boolean(inspection.data && !inspection.data.locked), retry: false });
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const candidates = useMemo(
    () => (preview.data ?? []).map((candidate) => ({ ...candidate, selected: selection[candidate.attachmentKey] ?? candidate.selected })),
    [preview.data, selection],
  );
  const selected = candidates.filter((candidate) => candidate.selected);
  const collections = useMemo(
    () => [...new Set(candidates.flatMap((candidate) => candidate.collections))].sort((left, right) => left.localeCompare(right)),
    [candidates],
  );
  const visible = candidates.filter((candidate) => {
    const matchesCollection = collectionFilter === "all" || candidate.collections.includes(collectionFilter) || (collectionFilter === "unfiled" && !candidate.collections.length);
    return matchesCollection && (showAll || candidate.selected);
  });
  const importMutation = useMutation({
    mutationFn: () => importFromZotero(root, inspection.data?.dataDir ?? "", candidates),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["papers", root] });
      void queryClient.invalidateQueries({ queryKey: ["jobs", root] });
    },
  });
  const counts = selected.reduce<Record<string, number>>((value, candidate) => ({ ...value, [candidate.category]: (value[candidate.category] ?? 0) + 1 }), {});
  const pageTotal = selected.reduce((total, candidate) => total + candidate.pageCount, 0);
  const ocrReady = Boolean(ocrStatus.data?.configured && ocrStatus.data.consent && !ocrStatus.data.workspaceRequired);
  const setVisibleSelection = (value: boolean) => setSelection((current) => ({ ...current, ...Object.fromEntries(visible.map((candidate) => [candidate.attachmentKey, value])) }));

  return <main className="import-page">
    <div className="page-title-block"><div className="page-icon"><FileInput size={20} /></div><div><h1>从 Zotero 导入</h1><p>将选中的 PDF 复制到 P2I，同时保留 Zotero 来源信息。</p></div></div>
    {inspection.isLoading ? <div className="inline-loading"><LoaderCircle className="spin" /> 正在检查 Zotero 论文库...</div> : inspection.isError ?
      <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>本地引擎不可用</strong><p>{inspection.error instanceof Error ? inspection.error.message : String(inspection.error ?? "Zotero 检查失败")}</p><button className="secondary-button" onClick={() => void inspection.refetch()}><RefreshCw size={14} /> 重试</button></div></div> : inspection.data?.locked ?
      <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>Zotero 论文库已锁定</strong><p>{inspection.data.lockReason}</p><p>请正常关闭 Zotero 后刷新。正式导入不会使用备份数据库。</p></div></div> : inspection.data && <>
        <section className="source-band"><Database size={18} /><div><strong>{inspection.data.dataDir}</strong><span>{inspection.data.itemCount} 个条目 | {inspection.data.pdfCount} 个 PDF | {inspection.data.missingPdfCount} 个缺失</span></div><span className="source-ready"><CheckCircle2 size={14} /> 只读</span></section>
        {!ocrReady && <div className="notice warning-notice"><AlertTriangle size={19} /><div><strong>尚未配置 OCR</strong><p>仍可复制 PDF 并加入队列；配置 OCR 前，解析任务可能会标记为部分完成。</p></div></div>}
        <div className="sample-summary">
          <div><span>已选择</span><strong>{selected.length}</strong><small>共 {inspection.data.pdfCount} 个 PDF</small></div>
          <div><span>预计页数</span><strong>{pageTotal}</strong><small>将加入解析队列</small></div>
          <div><span>FinFT</span><strong>{counts.finft ?? 0}</strong><small>financial AI</small></div>
          <div><span>多模态</span><strong>{counts.multimodal ?? 0}</strong><small>对话研究</small></div>
        </div>
        <section className="import-table-wrap">
          <div className="import-table-heading"><div><h2>选择 Zotero PDF</h2><p>{showAll ? `${visible.length} 个匹配条目` : `${visible.length} 个已选条目`}</p></div><div className="import-controls"><ListFilter size={16} /><select aria-label="筛选 Zotero 分类" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="all">全部分类</option>{collections.map((collection) => <option key={collection} value={collection}>{collection}</option>)}<option value="unfiled">未分类</option></select><button className="secondary-button" onClick={() => setShowAll((value) => !value)}>{showAll ? "仅显示已选" : "显示全部"}</button><button className="secondary-button" onClick={() => setVisibleSelection(true)} disabled={!visible.length}>全选可见项</button><button className="secondary-button" onClick={() => setVisibleSelection(false)} disabled={!visible.length}>清空可见项</button></div></div>
          <div className="import-table">{visible.map((candidate) => <CandidateRow candidate={candidate} key={candidate.attachmentKey} onChange={(value) => setSelection((current) => ({ ...current, [candidate.attachmentKey]: value }))} />)}</div>
        </section>
        <footer className="import-footer"><div><strong>目标位置</strong><span>{root}\Papers\Zotero</span></div><button className="primary-button" disabled={!selected.length || importMutation.isPending} onClick={() => importMutation.mutate()}>{importMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <FileInput size={16} />} 导入 {selected.length} 篇论文</button></footer>
        {importMutation.isSuccess && <div className="toast-success"><CheckCircle2 size={15} /> 已复制 {importMutation.data.copied} 个 PDF，并创建 {importMutation.data.enqueued} 个解析任务。可在“任务活动”中查看进度。</div>}
        {importMutation.isError && <div className="notice error-notice import-result-error"><AlertTriangle size={19} /><div><strong>导入未能完成</strong><p>{importMutation.error instanceof Error ? importMutation.error.message : String(importMutation.error)}</p></div></div>}
      </>}
  </main>;
}

function CandidateRow({ candidate, onChange }: { candidate: ZoteroImportCandidate; onChange: (selected: boolean) => void }) {
  return <label className="import-row">
    <input type="checkbox" checked={candidate.selected} onChange={(event) => onChange(event.target.checked)} />
    <span className={`category-swatch category-${candidate.category}`} />
    <span className="import-paper"><strong>{candidate.title}</strong><small>{candidate.collections.join(" / ") || "未分类"} | {candidate.year ?? "未知年份"}</small></span>
    <span>{candidate.pageCount} 页</span><span>{(candidate.sizeBytes / 1_048_576).toFixed(1)} MB</span>
  </label>;
}
