import { AlertTriangle, Database, RefreshCw } from "lucide-react";

export function LibraryStartup({ error, onRetry }: { error?: Error | null; onRetry: () => void }) {
  if (error) {
    return <main className="library-startup error-state" role="alert">
      <div className="startup-status">
        <span className="startup-icon error"><AlertTriangle size={20} /></span>
        <div><strong>Local engine unavailable</strong><span>{error.message}</span></div>
        <button className="secondary-button" onClick={onRetry}><RefreshCw size={15} /> Retry</button>
      </div>
    </main>;
  }

  return <main className="library-startup" aria-busy="true" aria-live="polite">
    <div className="startup-status">
      <span className="startup-icon"><Database size={20} /></span>
      <div><strong>Starting local engine</strong><span>Opening Papers2Innovations-Library</span></div>
      <span className="startup-pulse"><i /><i /><i /></span>
    </div>
    <div className="startup-layout" aria-hidden="true">
      <div className="startup-column"><i /><i /><i /><i /></div>
      <div className="startup-document"><i /><i /><i /><i /><i /></div>
      <div className="startup-inspector"><i /><i /><i /></div>
    </div>
  </main>;
}
