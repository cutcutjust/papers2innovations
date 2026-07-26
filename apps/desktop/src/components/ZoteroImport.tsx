import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ZoteroImportCandidate } from "@p2i/contracts";
import { AlertTriangle, CheckCircle2, Database, FileInput, FolderTree, LoaderCircle, RefreshCw } from "lucide-react";
import { getOcrStatus, importFromZotero, inspectZotero, previewZoteroImport } from "../lib/bridge";

export function ZoteroImport({ root }: { root: string }) {
  const queryClient = useQueryClient();
  const inspection = useQuery({ queryKey: ["zotero-inspection"], queryFn: inspectZotero, retry: false });
  const ocrStatus = useQuery({ queryKey: ["ocr-status"], queryFn: getOcrStatus, retry: false });
  const preview = useQuery({ queryKey: ["zotero-preview"], queryFn: previewZoteroImport, enabled: Boolean(inspection.data && !inspection.data.locked), retry: false });
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const candidates = useMemo(() => (preview.data ?? []).map((candidate) => ({ ...candidate, selected: selection[candidate.attachmentKey] ?? candidate.selected })), [preview.data, selection]);
  const selected = candidates.filter((candidate) => candidate.selected);
  const importMutation = useMutation({ mutationFn: () => importFromZotero(root, candidates), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["papers", root] }) });
  const counts = selected.reduce<Record<string, number>>((value, candidate) => ({ ...value, [candidate.category]: (value[candidate.category] ?? 0) + 1 }), {});
  const pageTotal = selected.reduce((total, candidate) => total + candidate.pageCount, 0);
  const ocrReady = Boolean(ocrStatus.data?.configured && ocrStatus.data.consent && !ocrStatus.data.workspaceRequired);

  return <main className="import-page">
    <div className="page-title-block"><div className="page-icon"><FileInput size={20} /></div><div><h1>Import from Zotero</h1><p>Copy managed PDFs into P2I and retain source provenance.</p></div></div>
    {inspection.isLoading ? <div className="inline-loading"><LoaderCircle className="spin" /> Inspecting Zotero library...</div> : inspection.isError ?
      <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>Local engine unavailable</strong><p>{inspection.error instanceof Error ? inspection.error.message : String(inspection.error ?? "Zotero inspection failed")}</p><button className="secondary-button" onClick={() => void inspection.refetch()}><RefreshCw size={14} /> Retry</button></div></div> : inspection.data?.locked ?
      <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>Zotero library is locked</strong><p>{inspection.data.lockReason}</p><p>Close Zotero cleanly and refresh. Backups are never used for formal import.</p></div></div> : inspection.data && <>
        <section className="source-band"><Database size={18} /><div><strong>{inspection.data.dataDir}</strong><span>{inspection.data.itemCount} items · {inspection.data.pdfCount} PDFs · {inspection.data.missingPdfCount} missing</span></div><span className="source-ready"><CheckCircle2 size={14} /> Read-only</span></section>
        {!ocrReady && <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>Qwen OCR is not ready</strong><p>Save a credential, grant page-upload consent, and pass the connection test in Settings before formal import.</p></div></div>}
        <div className="sample-summary">
          <div><span>Selected</span><strong>{selected.length}</strong><small>of {inspection.data.pdfCount} PDFs</small></div>
          <div><span>Estimated pages</span><strong>{pageTotal}</strong><small>Qwen OCR on every page</small></div>
          <div><span>FinFT</span><strong>{counts.finft ?? 0}</strong><small>financial AI</small></div>
          <div><span>Multimodal</span><strong>{counts.multimodal ?? 0}</strong><small>conversation research</small></div>
        </div>
        <section className="import-table-wrap">
          <div className="import-table-heading"><div><h2>Deterministic regression sample</h2><p>Stratified by collection and page complexity.</p></div><FolderTree size={18} /></div>
          <div className="import-table">{candidates.filter((candidate) => candidate.selected).map((candidate) => <label className="import-row" key={candidate.attachmentKey}>
            <input type="checkbox" checked={candidate.selected} onChange={(event) => setSelection((current) => ({ ...current, [candidate.attachmentKey]: event.target.checked }))} />
            <span className={`category-swatch category-${candidate.category}`} />
            <span className="import-paper"><strong>{candidate.title}</strong><small>{candidate.collections.join(" / ") || "Unfiled"} · {candidate.year ?? "—"}</small></span>
            <span>{candidate.pageCount} pages</span><span>{(candidate.sizeBytes / 1_048_576).toFixed(1)} MB</span>
          </label>)}</div>
        </section>
        <footer className="import-footer"><div><strong>Destination</strong><span>{root}\Papers\Zotero</span></div><button className="primary-button" disabled={!selected.length || importMutation.isPending || !ocrReady} onClick={() => importMutation.mutate()}>{importMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <FileInput size={16} />} Import {selected.length} papers</button></footer>
        {importMutation.isSuccess && <div className="toast-success"><CheckCircle2 size={15} /> Import completed. Files are now managed by P2I.</div>}
      </>}
  </main>;
}
