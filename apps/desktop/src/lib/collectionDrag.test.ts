import { afterEach, describe, expect, it, vi } from "vitest";
import { beginCollectionDrag, finishCollectionDrag, readCollectionDrag, startPointerCollectionDrag } from "./collectionDrag";

describe("collection drag payload", () => {
  afterEach(() => {
    finishCollectionDrag();
    vi.unstubAllGlobals();
  });

  it("keeps the internal payload when WebView drag data is unavailable", () => {
    const transfer = { effectAllowed: "none", setData: () => { throw new Error("blocked"); }, getData: () => "" } as unknown as DataTransfer;
    beginCollectionDrag({ kind: "paper", id: "paper-1" }, transfer);
    expect(readCollectionDrag()).toEqual({ kind: "paper", id: "paper-1" });
    finishCollectionDrag();
    expect(readCollectionDrag()).toBeNull();
  });

  it("reads a collection payload from standard drag data as fallback", () => {
    const transfer = { getData: (type: string) => type === "application/x-p2i-collection-id" ? "folder-1" : "" } as unknown as DataTransfer;
    expect(readCollectionDrag(transfer)).toEqual({ kind: "collection", id: "folder-1" });
  });

  it("captures the pointer so a WebView rerender cannot lose a paper drag", () => {
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
    const source = { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() };
    startPointerCollectionDrag({ kind: "paper", id: "paper-2" }, { button: 0, pointerId: 7, clientX: 10, clientY: 20, currentTarget: source });
    expect(source.setPointerCapture).toHaveBeenCalledWith(7);
    finishCollectionDrag();
    expect(source.releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
