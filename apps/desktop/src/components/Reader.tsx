import type { LibraryPaper } from "@p2i/contracts";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Bot, Check, ChevronLeft, FileImage, FileText, Languages, Layers3, MessageSquareText, RefreshCw, Search, Send, Sigma, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { assetUrl, readMarkdown } from "../lib/bridge";
import { useWorkspace } from "../store";

type ReaderMode = "integrated" | "pdf" | "figures";
type Analysis = "translation" | "formula" | "theorem" | null;
type Section = { title: string; blocks: string[] };

function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: "Paper", blocks: [] };
  for (const chunk of markdown.split(/\n(?=#{1,3}\s)|\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
    const heading = chunk.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      if (current.blocks.length) sections.push(current);
      current = { title: heading[1], blocks: [] };
    } else current.blocks.push(chunk);
  }
  if (current.blocks.length || !sections.length) sections.push(current);
  return sections;
}

function MarkdownBlock({ value }: { value: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{value}</ReactMarkdown>;
}

export function Reader({ paper, root }: { paper?: LibraryPaper; root: string }) {
  const { setView, customModels } = useWorkspace();
  const [mode, setMode] = useState<ReaderMode>("integrated");
  const [fullText, setFullText] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [translated, setTranslated] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [analysis, setAnalysis] = useState<Analysis>(null);
  const [activeBlock, setActiveBlock] = useState("");
  const [agentModel, setAgentModel] = useState(customModels[0]?.id ?? "");
  const markdownQuery = useQuery({
    queryKey: ["paper-markdown", root, paper?.id],
    queryFn: () => readMarkdown(root, paper!.id),
    enabled: Boolean(paper?.id && paper && ["READY", "PARTIAL"].includes(paper.status)),
  });
  const sections = useMemo(() => parseSections(markdownQuery.data ?? ""), [markdownQuery.data]);
  const contextUsed = fullText ? 99840 : 46080;
  const contextPercent = Math.round(contextUsed / 128000 * 100);

  if (!paper) return <main className="reader-empty"><BookOpen size={34} /><h2>No paper selected</h2><p>Choose a paper in Library, then open it in Reader.</p><button className="primary-button compact" onClick={() => setView("library")}>Open Library</button></main>;

  const translate = (id: string) => { setTranslated((state) => ({ ...state, [id]: state[id] || 1 })); setSaved((state) => ({ ...state, [id]: false })); setActiveBlock(id); setAnalysis("translation"); };
  const explain = (type: "formula" | "theorem", id: string) => { setActiveBlock(id); setAnalysis(type); };
  const captureSelection = () => { const text = window.getSelection()?.toString().trim(); if (text) setSelectedText(text.slice(0, 64)); };

  return <div className="reader-workspace">
    <div className="reader-toolbar">
      <button onClick={() => setView("library")}><ChevronLeft size={13} /> Library</button>
      <strong title={paper.title}>{paper.title}</strong>
      <div className="reader-mode-switch"><button className={mode === "integrated" ? "active" : ""} onClick={() => setMode("integrated")}>Integrated Reading</button><button className={mode === "pdf" ? "active" : ""} onClick={() => setMode("pdf")}>PDF Only</button><button className={mode === "figures" ? "active" : ""} onClick={() => setMode("figures")}>Figures</button></div>
      <button><Search size={13} /> Find</button><button className={fullText ? "active" : ""} onClick={() => setFullText(!fullText)}><Layers3 size={13} /> {fullText ? `Full Text · ${contextPercent}%` : "Load Full Text"}</button>
    </div>
    <div className="reader-main">
      <aside className="reader-outline"><span>Outline</span>{sections.map((section, index) => <button key={`${section.title}-${index}`} className={index === 2 ? "active" : ""}>{section.title}<small>{section.blocks.length}</small></button>)}</aside>
      <main className="reader-canvas">
        {mode === "integrated" && <article className="integrated-paper">
          <header className="paper-reading-header"><span className="tag tag-primary">STRUCTURED MARKDOWN</span><h1>{paper.title}</h1><p>Local document · {paper.pageCount || "—"} pages · Updated {new Date(paper.updatedAt).toLocaleDateString()}</p></header>
          {selectedText && <div className="selection-toolbar"><span className="tag tag-ai">Selected</span><strong>“{selectedText}”</strong><button onClick={() => translate("selection")}><Languages size={12} /> Translate word</button><button onClick={() => explain("theorem", "selection")}><Sparkles size={12} /> Explain</button><button onClick={() => setSelectedText("")}>Close</button></div>}
          {markdownQuery.isLoading ? <div className="document-loading">Loading generated Markdown…</div> : sections.map((section, sectionIndex) => <section className={`reading-section ${sectionIndex === 0 ? "active" : ""}`} key={`${section.title}-${sectionIndex}`}>
            <header><div><h2>{section.title}</h2><span>{section.blocks.length} paragraphs · structured source</span></div><button><Layers3 size={12} /> Add Section</button></header>
            <div className="paragraph-stack">{section.blocks.map((block, blockIndex) => {
              const id = `${sectionIndex}-${blockIndex}`;
              const hasFormula = /\$|\\\[|\\begin\{equation/.test(block);
              return <div className={`paragraph-card ${activeBlock === id ? "active" : ""}`} key={id} onMouseUp={captureSelection}>
                <div className="paragraph-main"><span className="paragraph-number">{sectionIndex ? `${sectionIndex}.${blockIndex + 1}` : `A${blockIndex + 1}`}</span><div className="paragraph-markdown"><MarkdownBlock value={block} /></div><div className="paragraph-actions"><button onClick={() => translate(id)}><Languages size={12} /> Translate</button><button onClick={() => explain(hasFormula ? "formula" : "theorem", id)}><Sparkles size={12} /> Explain</button><button><Layers3 size={12} /> Add</button></div></div>
                {translated[id] && <div className="translation-result"><div><span className="tag tag-ai">Chinese Translation · Revision {translated[id]}</span>{saved[id] && <span className="tag tag-success"><Check size={10} /> Saved</span>}</div><p>该段落已转换为结构化中文译文，并与原文段落、章节和页码保持关联。译文可以独立保存，也可以随时使用当前翻译模型重新生成。</p><footer><button className={saved[id] ? "active" : ""} onClick={() => setSaved((state) => ({ ...state, [id]: !state[id] }))}>{saved[id] ? "Saved Translation" : "Save Translation"}</button><button onClick={() => { setTranslated((state) => ({ ...state, [id]: state[id] + 1 })); setSaved((state) => ({ ...state, [id]: false })); }}><RefreshCw size={11} /> Retranslate</button><button>Save as Note</button></footer></div>}
                {analysis && activeBlock === id && analysis !== "translation" && <AnalysisCard type={analysis} />}
              </div>;
            })}</div>
          </section>)}
        </article>}
        {mode === "pdf" && <div className="integrated-pdf">{assetUrl(paper.sourcePath) ? <iframe title="Source PDF" src={assetUrl(paper.sourcePath)} /> : <div className="pdf-placeholder"><FileText size={38} /><h2>Native PDF preview</h2><p>The source PDF is displayed here in the Windows desktop build.</p></div>}</div>}
        {mode === "figures" && <div className="reader-figures">{paper.figures.length ? paper.figures.map((figure) => <figure key={figure.id}>{assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`) ? <img src={assetUrl(`${paper.markdownPath?.replace(/[\\/][^\\/]+$/, "")}/${figure.relativePath}`)} alt={figure.caption ?? "Extracted figure"} /> : <div><FileImage size={32} /></div>}<figcaption>{figure.caption ?? "Extracted figure"}</figcaption></figure>) : <div className="pdf-placeholder"><FileImage size={36} /><h2>No extracted figures</h2><p>Figures will appear after the parser finishes extraction.</p></div>}</div>}
      </main>
      <aside className="reader-agent-panel">
        <header><Bot size={15} /><strong>Paper Analyst Agent</strong><span className="tag tag-success">Ready</span></header>
        <div className="agent-panel-scroll"><p className="agent-intro">I can explain selected passages, formulas and theorems, compare claims with your local library, and cite the source evidence.</p><div className="agent-context-card"><div><strong>Conversation Context</strong><b>{contextPercent}%</b></div><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><p>{(contextUsed / 1000).toFixed(1)}K / 128K tokens · {fullText ? "Full paper included" : "3 selected passages"}</p><button className={fullText ? "active" : ""} onClick={() => setFullText(!fullText)}>{fullText ? "Remove Full Text" : "Load Full Text"}</button></div><label className="agent-model-field"><span>Agent model</span><select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}>{customModels.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.format}</option>)}</select></label><div className="agent-tool-call"><span><Sparkles size={12} /> search_local_library</span><b>0.8 s</b><code>query: “attention routing”<br />results: {Math.max(3, sections.length)} papers</code></div><p className="agent-answer">The selected claim is grounded in the current section. I will keep the answer linked to its exact paragraph and page evidence.</p></div>
        <label className="agent-chat-input"><MessageSquareText size={13} /><input placeholder="Ask about this paper…" /><Send size={13} /></label>
      </aside>
    </div>
    <footer className="reader-context-bar"><Layers3 size={14} /><strong>Conversation Context</strong><span className={`tag ${fullText ? "tag-ai" : "tag-primary"}`}>{fullText ? "Full paper loaded" : "3 passages loaded"}</span><div className="context-track"><i style={{ width: `${contextPercent}%` }} /></div><code>{(contextUsed / 1000).toFixed(1)}K / 128K · {contextPercent}%</code><span>Updates immediately when sections or full text are added.</span><button onClick={() => setFullText(!fullText)}>{fullText ? "Remove Full Text" : "Load Full Text"}</button></footer>
  </div>;
}

function AnalysisCard({ type }: { type: "formula" | "theorem" }) {
  return <div className={`reader-analysis ${type}`}><span className="tag tag-ai">AI {type === "formula" ? "Formula" : "Theorem"} Explanation · Evidence grounded</span><h3>{type === "formula" ? "Formula intuition and term-by-term explanation" : "Claim, assumptions and proof sketch"}</h3>{type === "formula" ? <div className="formula-grid"><div><b>Inputs</b><p>Identifies each symbol and its role in the computation.</p></div><div><b>Operation</b><p>Explains the transformation and normalization step.</p></div><div><b>Output</b><p>Connects the result back to the surrounding method.</p></div></div> : <p><b>Interpretation.</b> The statement is explained under the assumptions made by the paper. The explanation distinguishes the supported claim from a broader conclusion and keeps the source passage attached.</p>}<footer><button>Save Explanation</button><button>Show Source Evidence</button><button>Ask Follow-up</button></footer></div>;
}
