import { useState } from "react";
import { Bot, CheckCircle2, Database, HardDrive, KeyRound, RefreshCw, ShieldCheck, Trash2, TriangleAlert, Type, X } from "lucide-react";
import { nativeRuntime, uninstallApplication } from "../lib/bridge";
import type { FontSize } from "../lib/fontSize";
import { useWorkspace } from "../store";
import { CHECK_UPDATE_EVENT } from "./AppUpdater";

type SecurityStatus = { kind: "success" | "error" | "info"; message: string };

export function SecuritySettings() {
  const { fontSize, setFontSize, setView } = useWorkspace();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const supportsNativeUninstall = nativeRuntime && navigator.userAgent.includes("Windows");

  const uninstall = async () => {
    if (!window.confirm("从此电脑卸载 Papers2Innovations？论文库、模型设置与用户数据会保留。")) return;
    setUninstalling(true);
    setStatus(null);
    try {
      await uninstallApplication();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      setUninstalling(false);
    }
  };

  return <main className="settings-page settings-page-refined security-settings-page">
    <header className="settings-hero">
      <div className="page-title-block"><div className="page-icon"><ShieldCheck size={20} /></div><div><h1>安全与应用</h1><p>管理显示偏好、版本更新、凭据保护与本机安装</p></div></div>
      <div className="settings-hero-actions">
        <button className="secondary-button" onClick={() => setView("settings")}><Bot size={14} /> 模型与处理</button>
        {nativeRuntime && <button className="primary-button compact" onClick={() => window.dispatchEvent(new Event(CHECK_UPDATE_EVENT))}><RefreshCw size={14} /> 检查新版本</button>}
      </div>
    </header>

    {status && <div className={`settings-status settings-global-status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>{status.kind === "error" ? <TriangleAlert size={16} /> : <CheckCircle2 size={16} />}<span>{status.message}</span><button onClick={() => setStatus(null)} title="关闭提示"><X size={14} /></button></div>}

    <section className="settings-section preference-section">
      <div className="settings-heading"><div><h2>阅读与显示</h2><p>字体大小会立即应用到整个系统，并在升级后保留。</p></div><Type size={18} /></div>
      <div className="font-preference-row"><span><strong>系统字体大小</strong><small>“中”是推荐默认值；阅读密集论文时可使用“大”。</small></span><div className="segmented-control large" aria-label="系统字体大小">{(["small", "medium", "large"] as FontSize[]).map((size) => <button key={size} className={fontSize === size ? "active" : ""} onClick={() => setFontSize(size)} aria-pressed={fontSize === size}>{size === "small" ? "小" : size === "medium" ? "中" : "大"}</button>)}</div></div>
    </section>

    <section className="settings-section security-section">
      <div className="settings-heading"><div><h2>密钥与隐私</h2><p>模型密钥只由原生安全层读取，不进入论文引擎、数据库或日志。</p></div><KeyRound size={18} /></div>
      <div className="security-detail-grid">
        <article><ShieldCheck size={17} /><span><strong>Stronghold 加密保险库</strong><small>API Key 加密保存，保险库密码由系统钥匙串自动管理。</small></span></article>
        <article><Database size={17} /><span><strong>数据层隔离</strong><small>Python sidecar 与 SQLite 均无法读取模型密钥。</small></span></article>
        <article><HardDrive size={17} /><span><strong>升级保留设置</strong><small>应用更新不会覆盖模型配置、密钥或论文库数据。</small></span></article>
      </div>
    </section>

    <section className="security-facts"><div><span>凭据保险库</span><strong>Stronghold + 系统钥匙串</strong></div><div><span>密钥可见范围</span><strong>仅原生进程内存</strong></div><div><span>OCR 并发</span><strong>2 页</strong></div><div><span>失败重试</span><strong>2 / 4 / 8 秒</strong></div></section>

    {supportsNativeUninstall && <section className="settings-section app-management"><div className="settings-heading"><div><h2>应用管理</h2><p>卸载程序本体，同时保留论文库、模型设置和加密凭据，便于以后重新安装。</p></div><Trash2 size={18} /></div><button className="danger-button" onClick={() => void uninstall()} disabled={uninstalling}><Trash2 size={15} /> {uninstalling ? "正在启动卸载程序…" : "卸载 Papers2Innovations"}</button></section>}
  </main>;
}
