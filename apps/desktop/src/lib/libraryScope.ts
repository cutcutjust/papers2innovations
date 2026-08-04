import type { LibraryPaper } from "@p2i/contracts";
import type { LibraryScope } from "../store";

const timestamp = (value?: string) => value ? Date.parse(value) || 0 : 0;

export function papersForLibraryScope(papers: LibraryPaper[], scope: LibraryScope): LibraryPaper[] {
  if (scope === "favorites") {
    return papers
      .filter((paper) => paper.isFavorite)
      .sort((left, right) => timestamp(right.favoritedAt) - timestamp(left.favoritedAt));
  }
  if (scope === "reading") {
    return papers
      .filter((paper) => Boolean(paper.lastReadAt))
      .sort((left, right) => timestamp(right.lastReadAt) - timestamp(left.lastReadAt));
  }
  if (scope === "recent") {
    return [...papers].sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  }
  return papers;
}
