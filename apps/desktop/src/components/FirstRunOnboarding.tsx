import { useEffect, useState } from "react";
import { Bot, Check, ChevronLeft, ChevronRight, Database, FileText, FolderOpen, Image as ImageIcon, Layers3, LockKeyhole, Sparkles, Upload } from "lucide-react";
import type { CredentialSummary, ModelConfig } from "@p2i/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { hydrateProviderCredentials } from "../lib/credentials";
import { CURRENT_ONBOARDING_VERSION, useWorkspace } from "../store";
import { ModelSetupPanel, type ModelSetupRole, type ModelSetupStatus } from "./ModelSetupPanel";
import { PaperImportDialog } from "./PaperImportDialog";

interface Props {
  root: string;
  suggestedRoot: string;
  libraryBusy: boolean;
  onCreateLibrary: () => Promise<void>;
  onChooseLibrary: () => Promise<void>;
}

export function FirstRunOnboarding({ root, suggestedRoot, libraryBusy, onCreateLibrary, onChooseLibrary }: Props) {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(root ? 2 : 0);
  const [editingRole, setEditingRole] = useState<ModelSetupRole | null>(null);
  const [status, setStatus] = useState<ModelSetupStatus | null>(null);
  const [summaries, setSummaries] = useState<Record<string, CredentialSummary>>({});

  const refreshCredentials = async () => {
    const next = await hydrateProviderCredentials(useWorkspace.getState().providers);
    setSummaries(Object.fromEntries(next.map((item) => [item.credentialId, item])));
  };
  useEffect(() => { void refreshCredentials(); }, [workspace.providers.length]);

  const roleReady = (modelId: string) => {
    const model = workspace.customModels.find((item) => item.id === modelId);
    const provider = workspace.providers.find((item) => item.id === model?.providerId);
    return Boolean(model && provider && summaries[provider.credentialId]?.configured);
  };
  const textReady = roleReady(workspace.defaultTextModelId);
  const visionReady = roleReady(workspace.visionAnalysisModelId);
  const textModel = workspace.customModels.find((item) => item.id === workspace.defaultTextModelId);

  const finish = (view: "library" | "import" = "library") => {
    workspace.setOnboardingVersion(CURRENT_ONBOARDING_VERSION);
    workspace.setView(view);
  };
  const saved = async (_model: ModelConfig) => {
    setEditingRole(null);
    await refreshCredentials();
  };
  const createLibrary = async () => {
    await onCreateLibrary();
    setStep(2);
  };
  const chooseLibrary = async () => {
    await onChooseLibrary();
    setStep(2);
  };

  const steps = ["欢迎", "本地论文库", "配置 AI", "添加论文"];
  return <main className="first-run-shell">
    <header className="first-run-header"><div className="first-run-brand"><span><Layers3 size={20} /></span><strong>Papers2Innovations</strong></div><div className="first-run-steps" aria-label="首次设置进度">{steps.map((label, index) => <span key={label} className={index === step ? "active" : index < step ? "done" : ""}><i>{index < step ? <Check size={12} /> : index + 1}</i><b>{label}</b></span>)}</div><small>所有设置稍后都能修改</small></header>
    <section className="first-run-stage">
      {step === 0 && <div className="first-run-welcome">
        <div className="welcome-mark"><Sparkles size={28} /></div>
        <p className="welcome-kicker">为中文母语研究者设计</p>
        <h1>从一篇本地 PDF 开始精读</h1>
        <p>先建立独立本地论文库，再按需连接你的 AI 模型。原始论文不会被移动或修改，更新应用也不会清空资料。</p>
        <div className="welcome-capabilities"><article><FileText size={19} /><strong>结构化精读</strong><span>章节、公式、插图和表格统一整理</span></article><article><Bot size={19} /><strong>中文阅读助手</strong><span>翻译、解释、语法精读与多轮问答</span></article><article><ImageIcon size={19} /><strong>视觉理解</strong><span>解读论文插图并辅助修复可疑公式</span></article></div>
        <button className="primary-button first-run-primary" onClick={() => setStep(1)}>开始设置 <ChevronRight size={17} /></button>
      </div>}

      {step === 1 && <div className="first-run-library">
        <span className="first-run-icon"><FolderOpen size={25} /></span><p className="welcome-kicker">第 1 步</p><h1>创建本地论文库</h1><p>推荐位置适合大多数用户。你也可以选择已有的 Papers2Innovations 资料库根目录。</p>
        <div className="recommended-library"><div><strong>推荐位置</strong><code>{suggestedRoot || "正在获取系统文档目录…"}</code></div><span>推荐</span></div>
        <div className="first-run-actions"><button className="primary-button" disabled={!suggestedRoot || libraryBusy} onClick={() => void createLibrary()}><FolderOpen size={16} /> {libraryBusy ? "正在创建…" : "使用推荐位置"}</button><button className="secondary-button" disabled={libraryBusy} onClick={() => void chooseLibrary()}><FolderOpen size={16} /> 选择其他位置</button></div>
        <div className="first-run-assurance"><LockKeyhole size={15} /><span><strong>升级安全</strong> 论文、模型设置和加密密钥保存在安装目录之外，更新应用时继续保留。</span></div>
        <button className="first-run-back" onClick={() => setStep(0)}><ChevronLeft size={14} /> 返回</button>
      </div>}

      {step === 2 && <div className="first-run-ai">
        <p className="welcome-kicker">第 2 步</p><h1>配置你的 AI 能力</h1><p>至少准备一个文本模型和一个视觉模型。同一个支持图片输入的多模态模型可以同时使用。</p>
        {status && <div className={`first-run-status ${status.kind}`}>{status.message}</div>}
        {editingRole ? <ModelSetupPanel key={`${editingRole}-${workspace.customModels.length}`} presetRole={editingRole} compact onCancel={() => setEditingRole(null)} onSaved={(model) => void saved(model)} onStatus={setStatus} /> : <div className="onboarding-model-grid">
          <article className={textReady ? "ready" : "pending"}><span><FileText size={21} /></span><div><small>必备能力 1</small><h2>文本模型</h2><p>用于阅读助手、翻译、解释、上下文压缩和创新推理。</p></div><b>{textReady ? `${textModel?.displayName ?? "文本模型"} 已就绪` : "尚未配置"}</b><button className={textReady ? "secondary-button" : "primary-button"} onClick={() => setEditingRole("text")}>{textReady ? "再添加一个" : "配置文本模型"}</button></article>
          <article className={visionReady ? "ready" : "pending"}><span><ImageIcon size={21} /></span><div><small>必备能力 2</small><h2>视觉模型</h2><p>用于论文插图解读和可疑公式区域修复，不会自动启用全文 OCR。</p></div><b>{visionReady ? `${workspace.customModels.find((item) => item.id === workspace.visionAnalysisModelId)?.displayName ?? "视觉模型"} 已就绪` : "尚未配置"}</b>{!visionReady && textReady && textModel && <button className="secondary-button reuse-model" onClick={() => { workspace.setVisionAnalysisModelId(textModel.id); setStatus({ kind: "success", message: `${textModel.displayName} 已同时用作视觉模型。` }); void refreshCredentials(); }}>复用 {textModel.displayName}</button>}<button className={visionReady ? "secondary-button" : "primary-button"} onClick={() => setEditingRole("vision")}>{visionReady ? "再添加一个" : "配置独立视觉模型"}</button></article>
        </div>}
        {!editingRole && <div className="first-run-footer-actions"><button className="text-button" onClick={() => setStep(3)}>稍后配置</button><button className="primary-button" onClick={() => setStep(3)}>{textReady && visionReady ? "AI 已就绪，继续" : "继续添加论文"} <ChevronRight size={15} /></button></div>}
      </div>}

      {step === 3 && <div className="first-run-import">
        <p className="welcome-kicker">第 3 步</p><h1>添加第一批论文</h1><p>本地 PDF 是默认导入方式。可以一次选择多篇，也可以直接拖到窗口中。</p>
        <button className="onboarding-local-import" onClick={() => workspace.openPaperImport()}><span><Upload size={27} /></span><strong>选择或拖入本地 PDF</strong><small>原子复制 · SHA-256 去重 · 自动进入解析队列</small></button>
        <div className="onboarding-optional-import"><Database size={18} /><div><strong>已经在使用 Zotero？</strong><span>这是可选方式，可自动发现数据库并按 collection 筛选。</span></div><button className="secondary-button" onClick={() => finish("import")}>打开 Zotero 向导</button></div>
        <div className="first-run-footer-actions"><button className="text-button" onClick={() => setStep(2)}><ChevronLeft size={14} /> 返回配置 AI</button><button className="secondary-button" onClick={() => finish()}>暂时跳过，进入论文库</button></div>
      </div>}
    </section>
    {root && <PaperImportDialog root={root} open={workspace.importDialogOpen} pendingPaths={workspace.pendingImportPaths} onClose={() => { workspace.closePaperImport(); finish(); }} onImported={() => { window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["papers", root] }), 800); }} onOpenZotero={() => finish("import")} onOpenActivity={() => { finish(); workspace.setView("jobs"); }} />}
  </main>;
}
