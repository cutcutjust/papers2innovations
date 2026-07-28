import type { LibraryCollection, LibraryPaper } from "@p2i/contracts";

export interface CollectionTreeNode extends LibraryCollection {
  children: CollectionTreeNode[];
  totalPaperCount: number;
}

export function collectionScopeIds(collections: LibraryCollection[], collectionId: string): Set<string> {
  const result = new Set<string>([collectionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of collections) {
      if (collection.parentId && result.has(collection.parentId) && !result.has(collection.id)) {
        result.add(collection.id);
        changed = true;
      }
    }
  }
  return result;
}

export function buildCollectionTree(collections: LibraryCollection[], papers: LibraryPaper[]): CollectionTreeNode[] {
  const paperSets = new Map<string, Set<string>>();
  for (const collection of collections) {
    const scope = collectionScopeIds(collections, collection.id);
    paperSets.set(collection.id, new Set(
      papers.filter((paper) => paper.collectionIds.some((id) => scope.has(id))).map((paper) => paper.id),
    ));
  }
  const nodes = new Map<string, CollectionTreeNode>();
  for (const collection of collections) {
    nodes.set(collection.id, { ...collection, children: [], totalPaperCount: paperSets.get(collection.id)?.size ?? 0 });
  }
  const roots: CollectionTreeNode[] = [];
  for (const collection of collections) {
    const node = nodes.get(collection.id)!;
    const parent = collection.parentId ? nodes.get(collection.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: CollectionTreeNode[]) => {
    items.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-CN"));
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

export function filterPapersByCollection(papers: LibraryPaper[], collections: LibraryCollection[], collectionId?: string): LibraryPaper[] {
  if (!collectionId) return papers;
  if (collectionId === "__uncategorized__") return papers.filter((paper) => paper.collectionIds.length === 0);
  const scope = collectionScopeIds(collections, collectionId);
  return papers.filter((paper) => paper.collectionIds.some((id) => scope.has(id)));
}
