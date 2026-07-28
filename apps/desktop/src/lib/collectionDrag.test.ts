import { describe, expect, it } from "vitest";
import { beginCollectionDrag, finishCollectionDrag, readCollectionDrag } from "./collectionDrag";

describe("collection drag payload", () => {
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
});
