import { Bot, CheckCircle2, KeyRound, MoreHorizontal, Play, Plus, Settings2, Sparkles } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../store";

const profiles = [
  ["Paper Analyst", "Explain passages and ground every claim", "#4f6bed", "Ready"],
  ["Translation Agent", "Translate paragraphs with saved revisions", "#3984d8", "Ready"],
  ["Figure Analyst", "Interpret diagrams, charts and captions", "#7357d8", "Ready"],
  ["Citation Agent", "Resolve references and shared citation paths", "#28a06a", "Idle"],
  ["Innovation Agent", "Synthesize testable research directions", "#d98916", "Running"],
  ["Novelty Critic", "Challenge novelty against local evidence", "#d64545", "Needs key"],
];

export function Agents() {
  const { customModels, setView } = useWorkspace();
  const [selected, setSelected] = useState(0);
  return <div className="agents-page">
    <header className="figma-page-header"><div><h1>Agent Center</h1><p>Specialized research agents · each stage can use a different custom model</p></div><div className="page-actions"><button className="secondary-button" onClick={() => setView("settings")}><Settings2 size={13} /> Model settings</button><button className="primary-button compact"><Plus size={13} /> New Agent</button></div></header>
    <div className="agent-layout">
      <section className="agent-grid">{profiles.map(([name, description, color, status], index) => <button key={name} className={`agent-card ${selected === index ? "selected" : ""}`} onClick={() => setSelected(index)}>
        <div className="agent-card-top"><span className="agent-icon" style={{ color, background: `${color}14`, borderColor: `${color}55` }}><Bot size={18} /></span><span className={`tag ${status === "Needs key" ? "tag-warning" : status === "Running" ? "tag-ai" : "tag-success"}`}>{status}</span><MoreHorizontal size={15} /></div>
        <h2>{name}</h2><p>{description}</p><div className="agent-card-meta"><span>{customModels[index % Math.max(1, customModels.length)]?.name ?? "No model"}</span><span>{index % 2 ? "128K" : "256K"} context</span></div>
        <footer><span><CheckCircle2 size={12} /> {index + 2} tools</span><span>{index === 4 ? "Active run" : "Last used today"}</span></footer>
      </button>)}</section>
      <aside className="agent-detail"><div className="agent-detail-title"><span className="agent-icon" style={{ color: profiles[selected][2], background: `${profiles[selected][2]}14` }}><Sparkles size={18} /></span><div><h2>{profiles[selected][0]}</h2><p>{profiles[selected][1]}</p></div></div><div className="agent-detail-section"><h3>Runtime model</h3><select defaultValue={customModels[selected % Math.max(1, customModels.length)]?.id}>{customModels.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.format}</option>)}</select><dl><div><dt>Context limit</dt><dd>128,000</dd></div><div><dt>Reasoning</dt><dd>High</dd></div><div><dt>Network</dt><dd>Academic</dd></div><div><dt>Write policy</dt><dd>Confirm</dd></div></dl></div><div className="agent-detail-section"><h3>Enabled tools</h3>{["Search local library", "Read structured paper", "Resolve evidence anchors", "Save research note"].map((tool) => <p className="tool-permission" key={tool}><CheckCircle2 size={13} /> {tool}</p>)}</div><div className="agent-detail-actions">{profiles[selected][3] === "Needs key" ? <button className="primary-button compact" onClick={() => setView("settings")}><KeyRound size={13} /> Configure API</button> : <button className="primary-button compact"><Play size={13} /> Start Agent</button>}<button className="secondary-button"><Settings2 size={13} /> Edit profile</button></div></aside>
    </div>
  </div>;
}
