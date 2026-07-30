import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, Check, FileText, Image as ImageIcon } from "lucide-react";
import type { CredentialSummary } from "@p2i/contracts";
import { hydrateProviderCredentials } from "../lib/credentials";
import { useWorkspace } from "../store";

export function ModelReadinessBanner() {
  const workspace = useWorkspace();
  const [summaries, setSummaries] = useState<Record<string, CredentialSummary>>({});

  useEffect(() => {
    void hydrateProviderCredentials(workspace.providers)
      .then((items) => setSummaries(Object.fromEntries(items.map((item) => [item.credentialId, item]))))
      .catch(() => setSummaries({}));
  }, [workspace.providers]);

  const ready = (modelId: string) => {
    const model = workspace.customModels.find((item) => item.id === modelId);
    const provider = workspace.providers.find((item) => item.id === model?.providerId);
    return Boolean(model && provider && summaries[provider.credentialId]?.configured);
  };
  const textReady = ready(workspace.defaultTextModelId);
  const visionReady = ready(workspace.visionAnalysisModelId);
  if (textReady && visionReady) return null;

  return <section className="model-readiness-banner" aria-label="AI 配置提醒">
    <span className="readiness-alert"><AlertCircle size={17} /></span>
    <div><strong>完善 AI 配置，解锁完整精读体验</strong><small>本地导入和基础阅读不受影响；密钥只保存在 Stronghold。</small></div>
    <span className={textReady ? "ready" : "pending"}>{textReady ? <Check size={12} /> : <FileText size={12} />} 文本模型</span>
    <span className={visionReady ? "ready" : "pending"}>{visionReady ? <Check size={12} /> : <ImageIcon size={12} />} 视觉模型</span>
    <button className="secondary-button" onClick={() => workspace.setView("settings")}>前往配置 <ArrowRight size={13} /></button>
  </section>;
}
