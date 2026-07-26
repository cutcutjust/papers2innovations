import { FolderOpen, RefreshCw, Search } from "lucide-react";
import { nativeRuntime } from "../lib/bridge";
import { useWorkspace } from "../store";

interface TopbarProps {
  scanning: boolean;
  onScan: () => void;
  onChooseLibrary: () => void;
}

export function Topbar({ scanning, onScan, onChooseLibrary }: TopbarProps) {
  const { root, query, setQuery } = useWorkspace();
  const folderName = root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Choose a library";
  return (
    <header className="topbar">
      <button className="workspace-switcher" onClick={onChooseLibrary} title={root || "Choose library folder"}>
        <FolderOpen size={16} />
        <span>{folderName}</span>
        {!nativeRuntime && <span className="demo-badge">Demo</span>}
      </button>
      <label className="search-box">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search title or path"
          aria-label="Search papers"
        />
        <kbd>Ctrl K</kbd>
      </label>
      <button className="icon-button" onClick={onScan} disabled={scanning || !root} title="Scan library now">
        <RefreshCw size={17} className={scanning ? "spin" : ""} />
      </button>
    </header>
  );
}

