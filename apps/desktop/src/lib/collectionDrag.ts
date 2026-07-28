export type CollectionDragPayload = { kind: "paper" | "collection"; id: string };

const PAPER_MIME = "application/x-p2i-paper-id";
const COLLECTION_MIME = "application/x-p2i-collection-id";
const DRAG_EVENT = "p2i:collection-drag";
const DROP_EVENT = "p2i:collection-pointer-drop";
let activePayload: CollectionDragPayload | null = null;
let activeTargetId = "";
let pointerSession: { payload: CollectionDragPayload; pointerId: number; startX: number; startY: number; dragging: boolean } | null = null;

export function beginCollectionDrag(payload: CollectionDragPayload, transfer?: DataTransfer): void {
  activePayload = payload;
  if (transfer) {
    transfer.effectAllowed = "move";
    try {
      transfer.setData(payload.kind === "paper" ? PAPER_MIME : COLLECTION_MIME, payload.id);
      transfer.setData("text/plain", payload.id);
    } catch {
      // WebView2 can reject custom drag data; the in-memory payload remains authoritative.
    }
  }
  dispatchDragState();
}

export function finishCollectionDrag(): void {
  activePayload = null;
  activeTargetId = "";
  dispatchDragState();
}

export function readCollectionDrag(transfer?: DataTransfer): CollectionDragPayload | null {
  if (activePayload) return activePayload;
  if (!transfer) return null;
  try {
    const collectionId = transfer.getData(COLLECTION_MIME);
    if (collectionId) return { kind: "collection", id: collectionId };
    const paperId = transfer.getData(PAPER_MIME) || transfer.getData("text/plain");
    return paperId ? { kind: "paper", id: paperId } : null;
  } catch {
    return null;
  }
}

export function subscribeCollectionDrag(listener: (payload: CollectionDragPayload | null, targetId: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = () => listener(activePayload, activeTargetId);
  window.addEventListener(DRAG_EVENT, handle);
  return () => window.removeEventListener(DRAG_EVENT, handle);
}

export function startPointerCollectionDrag(payload: CollectionDragPayload, event: { button: number; pointerId: number; clientX: number; clientY: number }): void {
  if (event.button !== 0 || typeof window === "undefined") return;
  cleanupPointerSession();
  pointerSession = { payload, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("pointercancel", handlePointerCancel, true);
}

export function subscribeCollectionDrop(listener: (payload: CollectionDragPayload, targetId: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ payload: CollectionDragPayload; targetId: string }>).detail;
    if (detail?.payload && detail.targetId) listener(detail.payload, detail.targetId);
  };
  window.addEventListener(DROP_EVENT, handle);
  return () => window.removeEventListener(DROP_EVENT, handle);
}

function dispatchDragState(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DRAG_EVENT));
}

function handlePointerMove(event: PointerEvent): void {
  if (!pointerSession || event.pointerId !== pointerSession.pointerId) return;
  if (!pointerSession.dragging && Math.hypot(event.clientX - pointerSession.startX, event.clientY - pointerSession.startY) < 6) return;
  if (!pointerSession.dragging) {
    pointerSession.dragging = true;
    activePayload = pointerSession.payload;
  }
  const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-collection-drop-id]")?.dataset.collectionDropId ?? "";
  if (targetId !== activeTargetId) {
    activeTargetId = targetId;
    dispatchDragState();
  }
  event.preventDefault();
}

function handlePointerUp(event: PointerEvent): void {
  if (!pointerSession || event.pointerId !== pointerSession.pointerId) return;
  const session = pointerSession;
  const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-collection-drop-id]")?.dataset.collectionDropId ?? activeTargetId;
  cleanupPointerSession();
  if (session.dragging && targetId) window.dispatchEvent(new CustomEvent(DROP_EVENT, { detail: { payload: session.payload, targetId } }));
  finishCollectionDrag();
}

function handlePointerCancel(event: PointerEvent): void {
  if (pointerSession && event.pointerId === pointerSession.pointerId) {
    cleanupPointerSession();
    finishCollectionDrag();
  }
}

function cleanupPointerSession(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerup", handlePointerUp, true);
    window.removeEventListener("pointercancel", handlePointerCancel, true);
  }
  pointerSession = null;
}
