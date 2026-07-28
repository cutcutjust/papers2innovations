import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, RefreshCw, Rocket, ShieldCheck, X } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { nativeRuntime } from "../lib/bridge";

type UpdatePhase = "hidden" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
export const CHECK_UPDATE_EVENT = "p2i:check-update";
export const AUTO_UPDATE_INTERVAL_MS = 30 * 60_000;
export const FOCUS_CHECK_INTERVAL_MS = 5 * 60_000;

export function updatePercent(downloaded: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

export function shouldRunUpdateCheck(lastCheckedAt: number, now: number, minimumInterval: number): boolean {
  return now - lastCheckedAt >= minimumInterval;
}

const readableError = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function AppUpdater() {
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const lastCheckedAt = useRef(0);
  const [phase, setPhase] = useState<UpdatePhase>("hidden");
  const [version, setVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  const checkForUpdate = useCallback(async (manual = false) => {
    if (!nativeRuntime || checkingRef.current) return;
    checkingRef.current = true;
    lastCheckedAt.current = Date.now();
    setError("");
    if (manual) setPhase("checking");
    try {
      const candidate = await check({ timeout: 15_000 });
      if (!candidate) {
        if (manual) {
          setPhase("current");
          window.setTimeout(() => setPhase((value) => value === "current" ? "hidden" : value), 3_500);
        }
        return;
      }
      if (updateRef.current && updateRef.current !== candidate) void updateRef.current.close();
      updateRef.current = candidate;
      setVersion(candidate.version);
      setReleaseNotes(candidate.body?.trim() ?? "本次更新包含功能改进、体验优化与稳定性修复。");
      setPhase("available");
    } catch (reason) {
      if (manual) {
        setError(readableError(reason));
        setPhase("error");
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!nativeRuntime) return;
    const startupTimer = window.setTimeout(() => void checkForUpdate(), 2_500);
    const interval = window.setInterval(() => void checkForUpdate(), AUTO_UPDATE_INTERVAL_MS);
    const manualCheck = () => void checkForUpdate(true);
    const checkWhenActive = () => {
      if (document.visibilityState === "visible" && shouldRunUpdateCheck(lastCheckedAt.current, Date.now(), FOCUS_CHECK_INTERVAL_MS)) {
        void checkForUpdate();
      }
    };
    window.addEventListener(CHECK_UPDATE_EVENT, manualCheck);
    window.addEventListener("focus", checkWhenActive);
    document.addEventListener("visibilitychange", checkWhenActive);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      window.removeEventListener(CHECK_UPDATE_EVENT, manualCheck);
      window.removeEventListener("focus", checkWhenActive);
      document.removeEventListener("visibilitychange", checkWhenActive);
    };
  }, [checkForUpdate]);

  const install = async () => {
    const update = updateRef.current;
    if (!update) return;
    setError("");
    setDownloaded(0);
    setTotal(0);
    setPhase("downloading");
    let received = 0;
    const onProgress = (event: DownloadEvent) => {
      if (event.event === "Started") {
        setTotal(event.data.contentLength ?? 0);
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        setDownloaded(received);
      } else {
        setPhase("installing");
      }
    };
    try {
      await update.downloadAndInstall(onProgress, { timeout: 15 * 60_000 });
      await relaunch();
    } catch (reason) {
      setError(readableError(reason));
      setPhase("error");
    }
  };

  const dismiss = () => {
    void updateRef.current?.close();
    updateRef.current = null;
    setPhase("hidden");
  };

  if (phase === "hidden") return null;
  const percent = updatePercent(downloaded, total);
  if (["checking", "current", "error"].includes(phase)) {
    return <aside className={`update-toast ${phase}`} aria-live="polite" role={phase === "error" ? "alert" : "status"}>
      <span className="update-toast-icon">{phase === "current" ? <CheckCircle2 size={17} /> : <RefreshCw className={phase === "checking" ? "spin" : ""} size={17} />}</span>
      <div><strong>{phase === "checking" ? "正在检查新版本" : phase === "current" ? "当前已是最新版本" : "更新检查失败"}</strong><small>{phase === "checking" ? "正在连接 GitHub Releases…" : phase === "current" ? "后续有新版本时会自动提醒你" : error}</small></div>
      {phase === "error" && <button onClick={() => void checkForUpdate(true)}><RefreshCw size={13} /> 重试</button>}
      {phase !== "checking" && <button className="icon-button small" title="关闭" onClick={dismiss}><X size={14} /></button>}
    </aside>;
  }

  return <div className="update-dialog-backdrop" role="presentation">
    <section className={`update-dialog ${phase}`} role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
      <header>
        <span className="update-dialog-mark">{phase === "available" ? <Rocket size={22} /> : <Download size={22} />}</span>
        <div><small>Papers2Innovations 更新</small><h2 id="update-dialog-title">{phase === "available" ? `新版本 ${version} 已准备好` : phase === "downloading" ? "正在安全下载更新" : "正在安装并准备重启"}</h2></div>
        {phase === "available" && <button className="icon-button" title="稍后提醒" onClick={dismiss}><X size={16} /></button>}
      </header>
      <div className="update-dialog-body">
        {phase === "available" ? <>
          <p>立即更新只需几分钟。论文库、模型设置和加密密钥都会保留。</p>
          <details><summary>查看本次更新内容</summary><div>{releaseNotes}</div></details>
          <div className="update-trust-row"><ShieldCheck size={16} /><span><strong>已签名的官方更新</strong><small>从 GitHub Release 下载并在安装前验证签名</small></span></div>
        </> : <>
          <div className="update-progress-copy"><span>{phase === "downloading" ? "下载进度" : "安装进度"}</span><b>{phase === "downloading" && percent !== undefined ? `${percent}%` : "请稍候"}</b></div>
          <i className={`update-progress ${percent === undefined ? "indeterminate" : ""}`}><b style={{ width: `${phase === "installing" ? 100 : percent ?? 28}%` }} /></i>
          <p>{phase === "downloading" ? "可以继续等待，下载完成后将自动安装。" : "安装完成后应用会自动重启，请不要关闭程序。"}</p>
        </>}
      </div>
      {phase === "available" && <footer><button className="secondary-button" onClick={dismiss}>稍后提醒</button><button className="primary-button compact" onClick={() => void install()}><Download size={15} /> 立即更新并重启</button></footer>}
    </section>
  </div>;
}
