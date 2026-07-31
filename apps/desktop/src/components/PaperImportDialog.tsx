import { useEffect, useState } from "react";
import { Bot, Database, Eye, FileCheck2, FileText, FolderInput, Layers3, LoaderCircle, Settings2, ShieldCheck, Upload, X } from "lucide-react";
import type { PdfImportOptions, PdfImportPreview } from "@p2i/contracts";
import { importPdfs, previewPdfImport, selectPdfPaths, type PdfImportResult } from "../lib/bridge";

interface Props {
  root: string;
  open: boolean;
  pendingPaths: string[];
  onClose: () => void;
  onImported: () => void;
  onOpenZotero: () => void;
  onOpenActivity: () => void;
  onOpenSettings?: () => void;
}

type ImportStatus = "idle" | "inspecting" | "preview" | "importing" | "done" | "error";

export function PaperImportDialog({ root, open, pendingPaths, onClose, onImported, onOpenZotero, onOpenActivity, onOpenSettings }: Props) {
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [paths, setPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<PdfImportPreview | null>(null);
  const [mode, setMode] = useState<PdfImportOptions["processingMode"]>("vision");
  const [result, setResult] = useState<PdfImportResult | null>(null);
  const [error, setError] = useState("");

  const inspect = async (selectedPaths: string[]) => {
    if (!selectedPaths.length) return;
    setStatus("inspecting");
    setError("");
    try {
      const inspected = await previewPdfImport(root, selectedPaths);
      setPaths(selectedPaths);
      setPreview(inspected);
      setMode(inspected.visionReady ? "vision" : "local");
      setStatus("preview");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const choose = async () => inspect(await selectPdfPaths());

  const confirmImport = async () => {
    if (!preview || !paths.length) return;
    setStatus("importing");
    setError("");
    try {
      const imported = await importPdfs(root, paths, { processingMode: mode, visionConfirmed: mode === "vision" });
      setResult(imported);
      setStatus("done");
      onImported();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setPreview(null);
    setPaths([]);
    setError("");
    setStatus("idle");
    if (pendingPaths.length) void inspect(pendingPaths);
    // A pending list identifies one native drop operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingPaths]);

  if (!open) return null;
  const encrypted = preview?.items.some((item) => item.encrypted) ?? false;
  return <div className="pdf-import-backdrop" role="presentation"><section className="pdf-import-dialog unified-import-dialog visual-import-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-import-title">
    <header><span><Upload size={20} /></span><div><h2 id="paper-import-title">添加论文</h2><p>先检查文件和预计调用量，确认后再复制并解析。</p></div><button title="关闭" onClick={onClose}><X size={16} /></button></header>

    {!preview && status !== "done" && <>
      <div className="import-source-label"><strong>本地 PDF</strong><span>推荐</span></div>
      <button className={`pdf-import-dropzone ${status}`} onClick={() => void choose()} disabled={status === "inspecting"}>{status === "inspecting" ? <LoaderCircle className="spin" size={28} /> : <Upload size={28} />}<strong>{status === "inspecting" ? "正在读取页数和文件信息…" : "选择或拖入一篇或多篇 PDF"}</strong><span>只在本地检查文件；确认前不会上传页面或产生模型费用</span></button>
      <div className="pdf-import-assurance"><span><ShieldCheck size={15} /><b>原子复制</b><small>校验完成后才进入论文库</small></span><span><Layers3 size={15} /><b>可恢复解析</b><small>中断后从未完成页面继续</small></span><span><FileText size={15} /><b>原文保留</b><small>不会移动或修改源 PDF</small></span></div>
    </>}

    {preview && status !== "done" && <div className="import-preview-body">
      <div className="import-preview-summary"><div><strong>{preview.fileCount}</strong><span>篇论文</span></div><div><strong>{preview.pageCount}</strong><span>页</span></div><div><strong>{preview.estimatedVisionCalls}</strong><span>预计页面调用</span></div></div>
      <div className="import-file-preview">{preview.items.map((item) => <div key={item.path}><FileText size={15} /><span><strong>{item.filename}</strong><small>{item.pageCount} 页 · {(item.sizeBytes / 1024 / 1024).toFixed(1)} MB</small></span>{item.encrypted && <b>已加密</b>}</div>)}</div>
      <div className="processing-mode-options" role="radiogroup" aria-label="解析方式">
        <button className={mode === "vision" ? "active" : ""} disabled={!preview.visionReady} onClick={() => setMode("vision")}><span><Eye size={18} /></span><div><strong>高质量视觉重建 <b>默认</b></strong><small>每页对照 PDF 识别正文、公式、图表和章节结构</small><em>{preview.visionReady ? `使用 ${preview.visionModelName ?? "已配置视觉模型"}` : "视觉模型尚未配置"}</em></div></button>
        <button className={mode === "local" ? "active" : ""} onClick={() => setMode("local")}><span><FileText size={18} /></span><div><strong>仅本地基础解析</strong><small>不上传页面、不产生模型费用；复杂公式和排版可能不完整</small></div></button>
      </div>
      {!preview.visionReady && <div className="import-model-required"><Bot size={17} /><span><strong>配置视觉模型可获得完整 Markdown</strong><small>也可以先使用本地模式导入，之后手动重解析。</small></span>{onOpenSettings && <button onClick={onOpenSettings}><Settings2 size={14} /> 前往配置</button>}</div>}
      {mode === "vision" && <div className="vision-cost-confirm"><ShieldCheck size={15} /><span>确认后将把 {preview.pageCount} 个渲染页面发送给 <strong>{preview.visionModelName ?? "视觉模型"}</strong>。成功页面会缓存，不会在恢复任务时重复调用。</span></div>}
      <div className="import-preview-actions"><button className="secondary-button" onClick={() => { setPreview(null); setPaths([]); setStatus("idle"); }}>重新选择</button><button className="primary-button" disabled={encrypted || (mode === "vision" && !preview.visionReady) || status === "importing"} onClick={() => void confirmImport()}>{status === "importing" ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{status === "importing" ? "正在复制并加入队列…" : mode === "vision" ? `确认并识别 ${preview.pageCount} 页` : "使用本地模式导入"}</button></div>
    </div>}

    {status === "done" && <div className="import-complete"><FileCheck2 size={31} /><strong>论文已加入解析队列</strong><span>{result ? `复制 ${result.copied} 篇，跳过重复 ${result.deduplicated} 篇` : ""}</span><small>可以关闭窗口继续使用应用，解析将在后台进行。</small></div>}
    {status === "error" && <p className="pdf-import-error" role="alert">{error}</p>}
    {!preview && status !== "done" && <div className="optional-import-source"><div><span><Database size={17} /></span><div><strong>使用 Zotero 导入</strong><small>可选。自动发现 Zotero 数据库并按 collection 筛选。</small></div></div><button className="secondary-button" onClick={() => { onClose(); onOpenZotero(); }}><FolderInput size={14} /> 打开 Zotero 向导</button></div>}
    <footer><small>保存位置：{result?.destination ?? `${root}/Papers/Manual`}</small><div><button className="secondary-button" onClick={onClose}>{status === "done" ? "完成" : "取消"}</button>{status === "done" && <button className="primary-button compact" onClick={() => { onClose(); onOpenActivity(); }}>查看解析进度</button>}</div></footer>
  </section></div>;
}
