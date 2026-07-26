import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { nativeRuntime } from "../lib/bridge";

type UpdatePhase = "hidden" | "available" | "downloading" | "installing" | "error";

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

  const checkForUpdate = async () => {
    if (!nativeRuntime) return;
    try {
      const candidate = await check({ timeout: 10_000 });
      if (!candidate) return;
      updateRef.current = candidate;
      setVersion(candidate.version);
      setPhase("available");
    } catch {
      // Update checks never block the local workspace.
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void checkForUpdate(), 2_500);
    return () => window.clearTimeout(timer);
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
      <strong>{phase === "available" ? `Version ${version} is available` : phase === "downloading" ? "Downloading update" : phase === "installing" ? "Installing update" : "Update failed"}</strong>
      <span>{phase === "available" ? "Signed Windows update" : phase === "downloading" ? (percent === undefined ? "Downloading..." : `${percent}%`) : phase === "installing" ? "The app will restart automatically" : error}</span>
      {phase === "downloading" && <i className="update-progress"><b style={{ width: `${percent ?? 12}%` }} /></i>}
    </div>
    {phase === "available" && <button className="primary-button compact" onClick={() => void install()}><Download size={15} /> Update</button>}
    {phase === "error" && <button className="secondary-button" onClick={() => void install()}><RefreshCw size={14} /> Retry</button>}
    {(phase === "available" || phase === "error") && <button className="icon-button small" title="Remind me later" onClick={dismiss}><X size={14} /></button>}
  </aside>;
}
