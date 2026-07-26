import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ZoteroImportCandidate } from "@p2i/contracts";
import { AlertTriangle, CheckCircle2, Database, FileInput, FolderTree, ListFilter, LoaderCircle, RefreshCw } from "lucide-react";
import { getOcrStatus, importFromZotero, inspectZotero, previewZoteroImport } from "../lib/bridge";

export function ZoteroImport({ root }: { root: string }) {
  const queryClient = useQueryClient();
  const inspection = useQuery({ queryKey: ["zotero-inspection"], queryFn: inspectZotero, retry: false });
  const ocrStatus = useQuery({ queryKey: ["ocr-status"], queryFn: getOcrStatus, retry: false });
  const preview = useQuery({ queryKey: ["zotero-preview"], queryFn: previewZoteroImport, enabled: Boolean(inspection.data && !inspection.data.locked), retry: false });
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const candidates = useMemo(
    () => (preview.data ?? []).map((candidate) => ({ ...candidate, selected: selection[candidate.attachmentKey] ?? candidate.selected })),
    [preview.data, selection],
  );
  const selected = candidates.filter((candidate) => candidate.selected);
  const collections = useMemo(
    () => [...new Set(candidates.flatMap((candidate) => candidate.collections))].sort((left, right) => left.localeCompare(right)),
    [candidates],
  );
  const visible = candidates.filter((candidate) => {
    const matchesCollection = collectionFilter === "all" || candidate.collections.includes(collectionFilter) || (collectionFilter === "unfiled" && !candidate.collections.length);
    return matchesCollection && (showAll || candidate.selected);
  });
  const importMutation = useMutation({
    mutationFn: () => importFromZotero(root, inspection.data?.dataDir ?? "", candidates),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["papers", root] });
      void queryClient.invalidateQueries({ queryKey: ["jobs", root] });
    },
  });
  const counts = selected.reduce<Record<string, number>>((value, candidate) => ({ ...value, [candidate.category]: (value[candidate.category] ?? 0) + 1 }), {});
  const pageTotal = selected.reduce((total, candidate) => total + candidate.pageCount, 0);
  const ocrReady = Boolean(ocrStatus.data?.configured && ocrStatus.data.consent && !ocrStatus.data.workspaceRequired);
  const setVisibleSelection = (value: boolean) => setSelection((current) => ({ ...current, ...Object.fromEntries(visible.map((candidate) => [candidate.attachmentKey, value])) }));

  return <main className="import-page">
    <div className="page-title-block"><div className="page-icon"><FileInput size={20} /></div><div><h1>Import from Zotero</h1><p>Copy selected PDFs into P2I and preserve Zotero provenance.</p></div></div>
    {inspection.isLoading ? <div className="inline-loading"><LoaderCircle className="spin" /> Inspecting Zotero library...</div> : inspection.isError ?
      <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>Local engine unavailable</strong><p>{inspection.error instanceof Error ? inspection.error.message : String(inspection.error ?? "Zotero inspection failed")}</p><button className="secondary-button" onClick={() => void inspection.refetch()}><RefreshCw size={14} /> Retry</button></div></div> : inspection.data?.locked ?
      <div className="notice error-notice"><AlertTriangle size={19} /><div><strong>Zotero library is locked</strong><p>{inspection.data.lockReason}</p><p>Close Zotero cleanly and refresh. Backups are never used for formal import.</p></div></div> : inspection.data && <>
        <section className="source-band"><Database size={18} /><div><strong>{inspection.data.dataDir}</strong><span>{inspection.data.itemCount} items | {inspection.data.pdfCount} PDFs | {inspection.data.missingPdfCount} missing</span></div><span className="source-ready"><CheckCircle2 size={14} /> Read-only</span></section>
        {!ocrReady && <div className="notice warning-notice"><AlertTriangle size={19} /><div><strong>OCR is not configured</strong><p>PDFs can still be copied and queued. Their parse jobs will be marked partial until OCR is configured.</p></div></div>}
        <div className="sample-summary">
          <div><span>Selected</span><strong>{selected.length}</strong><small>of {inspection.data.pdfCount} PDFs</small></div>
          <div><span>Estimated pages</span><strong>{pageTotal}</strong><small>queued for parsing</small></div>
          <div><span>FinFT</span><strong>{counts.finft ?? 0}</strong><small>financial AI</small></div>
          <div><span>Multimodal</span><strong>{counts.multimodal ?? 0}</strong><small>conversation research</small></div>
        </div>
        <section className="import-table-wrap">
          <div className="import-table-heading"><div><h2>Zotero PDF selection</h2><p>{showAll ? `${visible.length} matching candidates` : `${visible.length} selected candidates`}</p></div><div className="import-controls"><ListFilter size={16} /><select aria-label="Filter Zotero collection" value={collectionFilter} onChange={(event) => setCollectionFilter(event.target.value)}><option value="all">All collections</option>{collections.map((collection) => <option key={collection} value={collection}>{collection}</option>)}<option value="unfiled">Unfiled</option></select><button className="secondary-button" onClick={() => setShowAll((value) => !value)}>{showAll ? "Selected only" : "Show all"}</button><button className="secondary-button" onClick={() => setVisibleSelection(true)} disabled={!visible.length}>Select visible</button><button className="secondary-button" onClick={() => setVisibleSelection(false)} disabled={!visible.length}>Clear visible</button></div></div>
          <div className="import-table">{visible.map((candidate) => <CandidateRow candidate={candidate} key={candidate.attachmentKey} onChange={(value) => setSelection((current) => ({ ...current, [candidate.attachmentKey]: value }))} />)}</div>
        </section>
        <footer className="import-footer"><div><strong>Destination</strong><span>{root}\Papers\Zotero</span></div><button className="primary-button" disabled={!selected.length || importMutation.isPending} onClick={() => importMutation.mutate()}>{importMutation.isPending ? <LoaderCircle className="spin" size={16} /> : <FileInput size={16} />} Import {selected.length} papers</button></footer>
        {importMutation.isSuccess && <div className="toast-success"><CheckCircle2 size={15} /> Copied {importMutation.data.copied} PDFs and queued {importMutation.data.enqueued} parse jobs. Track progress in Activity.</div>}
        {importMutation.isError && <div className="notice error-notice import-result-error"><AlertTriangle size={19} /><div><strong>Import could not finish</strong><p>{importMutation.error instanceof Error ? importMutation.error.message : String(importMutation.error)}</p></div></div>}
      </>}
  </main>;
}

function CandidateRow({ candidate, onChange }: { candidate: ZoteroImportCandidate; onChange: (selected: boolean) => void }) {
  return <label className="import-row">
    <input type="checkbox" checked={candidate.selected} onChange={(event) => onChange(event.target.checked)} />
    <span className={`category-swatch category-${candidate.category}`} />
    <span className="import-paper"><strong>{candidate.title}</strong><small>{candidate.collections.join(" / ") || "Unfiled"} | {candidate.year ?? "Unknown"}</small></span>
    <span>{candidate.pageCount} pages</span><span>{(candidate.sizeBytes / 1_048_576).toFixed(1)} MB</span>
  </label>;
}
