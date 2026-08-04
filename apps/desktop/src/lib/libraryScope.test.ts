import { describe, expect, it } from "vitest";
import type { LibraryPaper } from "@p2i/contracts";
import { papersForLibraryScope } from "./libraryScope";

const paper = (id: string, patch: Partial<LibraryPaper> = {}): LibraryPaper => ({
  id,
  title: id,
  authors: [],
  tags: [],
  sourcePath: `${id}.pdf`,
  status: "READY",
  progress: 1,
  pageCount: 10,
  figures: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  collectionIds: [],
  isFavorite: false,
  readingProgress: 0,
  ...patch,
});

describe("library scopes", () => {
  const papers = [
    paper("older-favorite", { isFavorite: true, favoritedAt: "2026-01-02T00:00:00Z" }),
    paper("recent-reading", { createdAt: "2026-01-04T00:00:00Z", lastReadAt: "2026-01-05T00:00:00Z", readingProgress: 0.6 }),
    paper("newer-favorite", { isFavorite: true, favoritedAt: "2026-01-03T00:00:00Z" }),
  ];

  it("shows only favorites in most-recently-favorited order", () => {
    expect(papersForLibraryScope(papers, "favorites").map((item) => item.id)).toEqual(["newer-favorite", "older-favorite"]);
  });

  it("shows only papers with reading history", () => {
    expect(papersForLibraryScope(papers, "reading").map((item) => item.id)).toEqual(["recent-reading"]);
  });

  it("sorts recent imports by their creation time", () => {
    expect(papersForLibraryScope(papers, "recent").map((item) => item.id)[0]).toBe("recent-reading");
  });
});
