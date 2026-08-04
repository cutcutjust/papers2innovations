import type { LibraryPaper, PaperDeleteResult, PaperMetadataUpdate } from "@p2i/contracts";
import { AlertTriangle, FilePenLine, LoaderCircle, Save, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { deletePaper, updatePaperMetadata } from "../lib/bridge";

type DialogMode = "edit" | "delete";

interface Props {
  root: string;
  paper: LibraryPaper;
  initialMode?: DialogMode;
  onClose: () => void;
  onSaved: (paper: LibraryPaper) => void;
  onDeleted: (result: PaperDeleteResult) => void;
}

const splitList = (value: string) => value
  .split(/[\n,，;；]+/)
  .map((item) => item.trim())
  .filter(Boolean);

export function PaperLibraryDialog({ root, paper, initialMode = "edit", onClose, onSaved, onDeleted }: Props) {
  const [mode, setMode] = useState<DialogMode>(initialMode);
  const [title, setTitle] = useState(paper.title);
  const [authors, setAuthors] = useState(paper.authors.join("\n"));
  const [year, setYear] = useState(paper.year ? String(paper.year) : "");
  const [venue, setVenue] = useState(paper.venue ?? "");
  const [doi, setDoi] = useState(paper.doi ?? "");
  const [tags, setTags] = useState(paper.tags.join("，"));
  const [abstract, setAbstract] = useState(paper.abstract ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setError("请填写论文标题。");
      return;
    }
    const payload: PaperMetadataUpdate = {
      title: normalizedTitle,
      authors: splitList(authors),
      year: year.trim() ? Number(year) : undefined,
      venue: venue.trim() || undefined,
      doi: doi.trim() || undefined,
      abstract: abstract.trim() || undefined,
      tags: splitList(tags),
    };
    setBusy(true);
    setError("");
    try {
      onSaved(await updatePaperMetadata(root, paper.id, payload));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onDeleted(await deletePaper(root, paper.id));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return <div className="paper-manage-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="paper-manage-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-manage-title">
      <header>
        <span>{mode === "edit" ? <FilePenLine size={20} /> : <Trash2 size={20} />}</span>
        <div><h2 id="paper-manage-title">{mode === "edit" ? "编辑论文信息" : "从论文库删除"}</h2><p>{mode === "edit" ? "人工修订会被保留，重新解析不会覆盖。" : "删除 P2I 管理的副本和关联阅读数据。"}</p></div>
        <button title="关闭" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16} /></button>
      </header>

      {mode === "edit" ? <form onSubmit={(event) => void save(event)}>
        <div className="paper-manage-fields">
          <label className="wide"><span>标题 <b>必填</b></span><input autoFocus value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>作者</span><textarea value={authors} rows={3} placeholder="每行一位作者" onChange={(event) => setAuthors(event.target.value)} /></label>
          <div className="paper-manage-field-stack"><label><span>年份</span><input inputMode="numeric" value={year} placeholder="例如 2026" onChange={(event) => setYear(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))} /></label><label><span>期刊 / 会议</span><input value={venue} maxLength={500} onChange={(event) => setVenue(event.target.value)} /></label></div>
          <label className="wide"><span>DOI</span><input value={doi} maxLength={300} placeholder="10.xxxx/xxxxx" onChange={(event) => setDoi(event.target.value)} /></label>
          <label className="wide"><span>标签</span><input value={tags} placeholder="用逗号分隔" onChange={(event) => setTags(event.target.value)} /></label>
          <label className="wide"><span>摘要</span><textarea value={abstract} rows={5} maxLength={20_000} placeholder="可选，保存人工核验后的摘要" onChange={(event) => setAbstract(event.target.value)} /></label>
        </div>
        {error && <p className="paper-manage-error" role="alert">{error}</p>}
        <footer><button type="button" className="paper-delete-link" onClick={() => { setMode("delete"); setError(""); }}><Trash2 size={14} /> 删除论文</button><div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{busy ? "正在保存…" : "保存修改"}</button></div></footer>
      </form> : <div className="paper-delete-confirm">
        <div className="paper-delete-warning"><AlertTriangle size={22} /><div><strong>确认删除“{paper.title}”吗？</strong><p>将删除当前论文库中的受管 PDF、解析产物、翻译、对话和上下文记录。不会访问或删除论文库外的原始 PDF，也不会修改 Zotero。</p></div></div>
        <dl><div><dt>受管文件</dt><dd>{paper.sourcePath}</dd></div><div><dt>阅读数据</dt><dd>标注、译文、问答与进度</dd></div></dl>
        {error && <p className="paper-manage-error" role="alert">{error}</p>}
        <footer><button className="secondary-button" disabled={busy} onClick={() => { setMode("edit"); setError(""); }}>返回编辑</button><div><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="danger-button" disabled={busy} onClick={() => void remove()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{busy ? "正在删除…" : "确认删除"}</button></div></footer>
      </div>}
    </section>
  </div>;
}
