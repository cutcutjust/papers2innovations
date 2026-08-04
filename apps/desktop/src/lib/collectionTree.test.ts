import { describe, expect, it } from "vitest";
import type { LibraryCollection, LibraryPaper } from "@p2i/contracts";
import { buildCollectionTree, filterPapersByCollection } from "./collectionTree";

const collections: LibraryCollection[] = [
  { id: "root", name: "研究", color: "#000000", sortOrder: 0, paperCount: 0, createdAt: "", updatedAt: "" },
  { id: "child", name: "多模态", parentId: "root", color: "#000000", sortOrder: 0, paperCount: 1, createdAt: "", updatedAt: "" },
];
const paper = (id: string, collectionIds: string[]): LibraryPaper => ({ id, title: id, authors: [], tags: [], sourcePath: `${id}.pdf`, status: "READY", progress: 1, pageCount: 1, figures: [], createdAt: "", updatedAt: "", collectionIds, isFavorite: false, readingProgress: 0 });
const papers = [paper("nested", ["child"]), paper("loose", [])];

describe("collection tree", () => {
  it("aggregates descendant papers into the parent", () => {
    const tree = buildCollectionTree(collections, papers);
    expect(tree[0].totalPaperCount).toBe(1);
    expect(tree[0].children[0].name).toBe("多模态");
  });

  it("filters parent scopes and uncategorized papers", () => {
    expect(filterPapersByCollection(papers, collections, "root").map((item) => item.id)).toEqual(["nested"]);
    expect(filterPapersByCollection(papers, collections, "__uncategorized__").map((item) => item.id)).toEqual(["loose"]);
  });
});
