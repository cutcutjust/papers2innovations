import type { LibraryPaper } from "@p2i/contracts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, ExternalLink, FileImage, FileJson2, FileText, LocateFixed, Maximize2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { assetUrl, readMarkdown } from "../lib/bridge";
import { useWorkspace } from "../store";
import { Status } from "./Status";

function Outline({ markdown }: { markdown: string }) {
  const headings = [...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1]);
  return (
    <aside className="outline">
      <div className="outline-title">On this paper</div>
      {headings.slice(0, 10).map((heading, index) => (
        <button key={`${heading}-${index}`} className={index === 0 ? "active" : ""}>{heading}</button>
      ))}
    </aside>
  );
}

function FigurePlaceholder({ caption }: { caption?: string }) {
  return (
    <figure className="scientific-figure">
      <div className="figure-canvas" aria-label="Scientific pipeline figure preview">
        <div className="figure-node node-source"><span>PDF</span><small>source</small></div>
        <span className="figure-arrow">→</span>
        <div className="figure-node node-layout"><span>Layout</span><small>blocks + pages</small></div>
        <span className="figure-arrow">→</span>
        <div className="figure-node node-evidence"><span>Evidence</span><small>grounded claims</small></div>
        <div className="figure-rail"><i /><i /><i /><i /></div>
      </div>
      <figcaption>{caption ?? "Extracted figure"}</figcaption>
    </figure>
  );
}

export function Reader({ paper, root }: { paper?: LibraryPaper; root: string }) {
  const { readerMode, setReaderMode, pdfPage, openPdfAt } = useWorkspace();
  const [figureModal, setFigureModal] = useState<LibraryPaper["figures"][number] | null>(null);
  const markdownQuery = useQuery({
    queryKey: ["paper-markdown", root, paper?.id],
    queryFn: () => readMarkdown(root, paper!.id),
    enabled: Boolean(paper?.id && ["READY", "PARTIAL"].includes(paper.status)),
  });
  if (!paper) {
    return <main className="reader empty-reader"><BookOpenText size={34} /><h2>Select a paper</h2><p>Choose an item from the library to inspect its generated artifacts.</p></main>;
  }
  const markdown = markdownQuery.data ?? "";
  return (
    <main className="reader">
      <header className="reader-header">
        <div className="reader-title-row">
          <div>
            <div className="eyebrow">Local paper · {paper.pageCount || "—"} pages</div>
            <h2>{paper.title}</h2>
          </div>
          <button className="icon-button" title="Open source file"><ExternalLink size={17} /></button>
        </div>
        <div className="reader-meta"><Status status={paper.status} /><span>Updated {new Date(paper.updatedAt).toLocaleDateString()}</span></div>
        <div className="reader-tabs" role="tablist">
          <button className={readerMode === "markdown" ? "active" : ""} onClick={() => setReaderMode("markdown")}><FileText size={15} /> Markdown</button>
          <button className={readerMode === "pdf" ? "active" : ""} onClick={() => setReaderMode("pdf")}><BookOpenText size={15} /> PDF</button>
          <button className={readerMode === "figures" ? "active" : ""} onClick={() => setReaderMode("figures")}><FileImage size={15} /> Figures <span>{paper.figures.length}</span></button>
        </div>
      </header>
      <div className="reader-body">
        {readerMode === "markdown" && ["READY", "PARTIAL"].includes(paper.status) && (
          <>
            <Outline markdown={markdown} />
            <article className="markdown-document">
              {markdownQuery.isLoading ? <div className="document-loading">Loading generated Markdown…</div> : (
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{markdown}</ReactMarkdown>
              )}
            </article>
          </>
        )}
        {readerMode === "pdf" && (
          <div className="pdf-viewer">
            {assetUrl(paper.sourcePath) ? <iframe title="Source PDF" src={`${assetUrl(paper.sourcePath)}#page=${pdfPage}`} /> : <><BookOpenText size={32} /><p>PDF preview is available in the native desktop app. Target page: {pdfPage}.</p></>}
          </div>
        )}
        {readerMode === "figures" && (
          <div className="figures-view">
            {paper.figures.length ? paper.figures.map((figure) => (
              <div className="figure-item" key={figure.id}>
                {assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`) ? (
                  <img src={assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`)} alt={figure.caption ?? "Extracted figure"} />
                ) : <FigurePlaceholder caption={figure.caption} />}
                <button className="icon-button figure-max" title="View full screen" onClick={() => setFigureModal(figure)}><Maximize2 size={16} /></button>
              </div>
            )) : <div className="empty-figures"><FileImage size={32} /><h3>No embedded figures found</h3><p>The paper remains readable; vector or scanned figures may require Docling.</p></div>}
          </div>
        )}
        {readerMode === "markdown" && !["READY", "PARTIAL"].includes(paper.status) && (
          <div className="processing-state">
            {paper.status === "FAILED" ? <FileJson2 size={34} /> : <div className="processing-ring" />}
            <h3>{paper.status === "FAILED" ? "Parsing needs attention" : "Document is being prepared"}</h3>
            <p>{paper.error ?? "The reader will become available when the persisted parse job finishes."}</p>
            {paper.progress > 0 && paper.progress < 1 && <div className="large-progress"><i style={{ width: `${paper.progress * 100}%` }} /></div>}
          </div>
        )}
      </div>
      {figureModal && <div className="figure-modal" role="dialog" aria-modal="true" aria-label="Figure preview">
        <div className="figure-modal-toolbar"><span>{figureModal.caption ?? "Extracted figure"}</span><button className="icon-button" onClick={() => setFigureModal(null)} title="Close"><X size={17} /></button></div>
        <div className="figure-modal-body">{assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figureModal.relativePath}`) ? <img src={assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figureModal.relativePath}`)} alt={figureModal.caption ?? "Extracted figure"} /> : <FigurePlaceholder caption={figureModal.caption} />}</div>
        <button className="locate-button" onClick={() => { openPdfAt(figureModal.page ?? 1); setFigureModal(null); }}><LocateFixed size={16} /> Open PDF page {figureModal.page ?? 1}</button>
      </div>}
    </main>
  );
}
