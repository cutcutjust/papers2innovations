import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { nativeRuntime } from "../lib/bridge";

type UpdatePhase = "hidden" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
export const CHECK_UPDATE_EVENT = "p2i:check-update";

export function updatePercent(downloaded: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

export function AppUpdater() {
  const updateRef = useRef<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("hidden");
  const [version, setVersion] = useState("");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  const checkForUpdate = async (manual = false) => {
    if (!nativeRuntime) return;
    if (manual) setPhase("checking");
    try {
      const candidate = await check({ timeout: 10_000 });
      if (!candidate) {
        if (manual) {
          setPhase("current");
          window.setTimeout(() => setPhase((value) => value === "current" ? "hidden" : value), 3_000);
        }
        return;
      }
      updateRef.current = candidate;
      setVersion(candidate.version);
      setPhase("available");
    } catch (reason) {
      if (manual) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      }
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void checkForUpdate(), 2_500);
    const manualCheck = () => void checkForUpdate(true);
    window.addEventListener(CHECK_UPDATE_EVENT, manualCheck);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(CHECK_UPDATE_EVENT, manualCheck);
    };
  }, []);

  const install = async () => {
    const update = updateRef.current;
    if (!update) return;
    setError("");
    setDownloaded(0);
    setTotal(0);
    setPhase("downloading");
    let received = 0;
    let expected = 0;
    const onProgress = (event: DownloadEvent) => {
      if (event.event === "Started") {
        expected = event.data.contentLength ?? 0;
        setTotal(expected);
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
      setError(reason instanceof Error ? reason.message : String(reason));
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
  return <aside className={`update-banner ${phase}`} aria-live="polite">
    <div className="update-copy">
      <strong>{phase === "checking" ? "正在检查更新" : phase === "current" ? "当前已是最新版本" : phase === "available" ? `发现新版本 ${version}` : phase === "downloading" ? "正在下载更新" : phase === "installing" ? "正在安装更新" : "更新失败"}</strong>
      <span>{phase === "checking" ? "正在连接 GitHub Releases" : phase === "current" ? "无需执行任何操作" : phase === "available" ? "已验证签名的应用更新" : phase === "downloading" ? (percent === undefined ? "下载中..." : `${percent}%`) : phase === "installing" ? "安装完成后应用将自动重启" : error}</span>
      {phase === "downloading" && <i className="update-progress"><b style={{ width: `${percent ?? 12}%` }} /></i>}
    </div>
    {phase === "available" && <button className="primary-button compact" onClick={() => void install()}><Download size={15} /> 立即更新</button>}
    {phase === "error" && <button className="secondary-button" onClick={() => void checkForUpdate(true)}><RefreshCw size={14} /> 重试</button>}
    {(phase === "available" || phase === "error") && <button className="icon-button small" title="稍后提醒" onClick={dismiss}><X size={14} /></button>}
  </aside>;
}
