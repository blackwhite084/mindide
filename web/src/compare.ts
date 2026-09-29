import type { Board, BoardNode } from "../../server/types.ts";

export type DiffKind = "added" | "modified";

export interface BoardDiff {
  /** 当前白板上的节点 → 相对历史版本的变化 */
  nodes: Map<string, DiffKind>;
  /** 历史版本里的节点（用于显示修改前的内容） */
  before: Map<string, BoardNode>;
  /** 当前已不存在的节点 */
  removed: BoardNode[];
  edgesAdded: number;
  edgesRemoved: number;
}

const contentOf = (n: BoardNode) => `${n.title}\n${n.summary}\n\n${n.md}`;

/** 历史版本 → 当前白板的差异 */
export function diffBoards(old: Board, current: BoardNode[], currentEdges: Board["edges"]): BoardDiff {
  const before = new Map(old.nodes.map((n) => [n.id, n]));
  const nodes = new Map<string, DiffKind>();
  for (const n of current) {
    if (n.draft) continue;
    const o = before.get(n.id);
    if (!o) nodes.set(n.id, "added");
    else if (contentOf(o) !== contentOf(n) || (o.parentId ?? null) !== (n.parentId ?? null)) nodes.set(n.id, "modified");
  }
  const ids = new Set(current.map((n) => n.id));
  const removed = old.nodes.filter((n) => !ids.has(n.id));
  const key = (e: Board["edges"][number]) => [e.source, e.target].sort().join("|");
  const oldEdges = new Set(old.edges.map(key));
  const newEdges = new Set(currentEdges.map(key));
  return {
    nodes,
    before,
    removed,
    edgesAdded: [...newEdges].filter((k) => !oldEdges.has(k)).length,
    edgesRemoved: [...oldEdges].filter((k) => !newEdges.has(k)).length,
  };
}

/** 对比用的完整文本（标题 + 摘要 + 正文） */
export const fullText = (n: BoardNode) => [n.title && `# ${n.title}`, n.summary && `> ${n.summary}`, n.md].filter(Boolean).join("\n\n");
