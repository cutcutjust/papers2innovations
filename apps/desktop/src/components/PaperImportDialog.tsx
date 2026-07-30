import { useEffect, useState } from "react";
import { Database, FileCheck2, FileText, FolderInput, Layers3, LoaderCircle, ShieldCheck, Upload, X } from "lucide-react";
import { importPdfs, type PdfImportResult } from "../lib/bridge";

interface Props {
  root: string;
  open: boolean;
  pendingPaths: string[];
  onClose: () => void;
  onImported: () => void;
  onOpenZotero: () => void;
  onOpenActivity: () => void;
}

export function PaperImportDialog({ root, open, pendingPaths, onClose, onImported, onOpenZotero, onOpenActivity }: Props) {
  const [status, setStatus] = useState<"idle" | "importing" | "done" | "error">("idle");
  const [result, setResult] = useState<PdfImportResult | null>(null);
  const [error, setError] = useState("");

  const addPdfs = async (paths: string[] = []) => {
    setStatus("importing");
    setError("");
    try {
      const imported = await importPdfs(root, paths);
      if (imported.selected === 0) {
        setStatus("idle");
        return;
      }
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
    setError("");
    setStatus("idle");
    if (pendingPaths.length) void addPdfs(pendingPaths);
    // The pending path list identifies a single native drop operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingPaths]);

  if (!open) return null;
  return <div className="pdf-import-backdrop" role="presentation"><section className="pdf-import-dialog unified-import-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-import-title">
    <header><span><Upload size={20} /></span><div><h2 id="paper-import-title">添加论文</h2><p>默认从本地导入，文件会安全复制到独立论文库。</p></div><button title="关闭" onClick={onClose}><X size={16} /></button></header>
    <div className="import-source-label"><strong>本地 PDF</strong><span>推荐</span></div>
    <button className={`pdf-import-dropzone ${status}`} onClick={() => void addPdfs()} disabled={status === "importing"}>{status === "importing" ? <LoaderCircle className="spin" size={28} /> : status === "done" ? <FileCheck2 size={28} /> : <Upload size={28} />}<strong>{status === "importing" ? "正在复制、校验并加入解析队列…" : status === "done" ? "论文已加入解析队列" : "选择或拖入一篇或多篇 PDF"}</strong><span>{status === "done" && result ? `复制 ${result.copied} 篇，跳过重复 ${result.deduplicated} 篇` : "支持批量选择；原文件不会被移动或修改"}</span></button>
    <div className="pdf-import-assurance"><span><ShieldCheck size={15} /><b>原子复制</b><small>校验完成后才进入论文库</small></span><span><Layers3 size={15} /><b>自动解析</b><small>生成章节、插图和表格</small></span><span><FileText size={15} /><b>自由归类</b><small>导入后拖到左侧文件树</small></span></div>
    {status === "error" && <p className="pdf-import-error" role="alert">{error}</p>}
    <div className="optional-import-source"><div><span><Database size={17} /></span><div><strong>使用 Zotero 导入</strong><small>可选。自动发现 Zotero 数据库并按 collection 筛选。</small></div></div><button className="secondary-button" onClick={() => { onClose(); onOpenZotero(); }}><FolderInput size={14} /> 打开 Zotero 向导</button></div>
    <footer><small>保存位置：{result?.destination ?? `${root}/Papers/Manual`}</small><div><button className="secondary-button" onClick={onClose}>{status === "done" ? "完成" : "取消"}</button>{status === "done" && <button className="primary-button compact" onClick={() => { onClose(); onOpenActivity(); }}>查看解析进度</button>}</div></footer>
  </section></div>;
}
