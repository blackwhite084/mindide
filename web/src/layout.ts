import type { BoardNode } from "../../server/types.ts";

export interface Size {
  w: number;
  h: number;
}

export interface Layout {
  pos: Map<string, { x: number; y: number }>;
  depth: Map<string, number>;
  /** 分支序号，用于给整条分支上色 */
  branch: Map<string, number>;
  /** 可见子节点数（含被折叠的） */
  childCount: Map<string, number>;
  visible: string[];
  /** 可见节点 → 可见父节点 */
  parent: Map<string, string>;
}

const GAP_X = 72;
const GAP_Y = 14;
const GAP_ROOT = 90;

export const widthOf = (depth: number) => (depth === 0 ? 320 : depth === 1 ? 290 : 270);

/**
 * 思维导图布局：根在左，子节点在右侧纵向排开，父节点相对子树垂直居中。
 * 手动固定（pinned）的节点以自己的位置为起点单独排它的子树。
 */
export function layoutTree(nodes: BoardNode[], sizes: Map<string, Size>): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string | null, BoardNode[]>();
  for (const n of nodes) {
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => a.createdAt - b.createdAt);

  const depth = new Map<string, number>();
  const branch = new Map<string, number>();
  const childCount = new Map<string, number>();
  const parent = new Map<string, string>();
  const visible: string[] = [];
  let branchSeq = 0;

  const visit = (n: BoardNode, d: number, b: number) => {
    depth.set(n.id, d);
    branch.set(n.id, b);
    visible.push(n.id);
    const cs = kids.get(n.id) ?? [];
    childCount.set(n.id, cs.length);
    if (n.fold) return;
    for (const c of cs) {
      parent.set(c.id, n.id);
      visit(c, d + 1, d === 0 ? branchSeq++ : b);
    }
  };
  const roots = kids.get(null) ?? [];
  for (const r of roots) visit(r, 0, -1);

  const size = (id: string): Size => sizes.get(id) ?? { w: widthOf(depth.get(id) ?? 2), h: 64 };
  const layoutKids = (id: string) =>
    byId.get(id)!.fold ? [] : (kids.get(id) ?? []).filter((c) => !c.pinned);

  const heightMemo = new Map<string, number>();
  const subtreeH = (id: string): number => {
    const cached = heightMemo.get(id);
    if (cached !== undefined) return cached;
    const cs = layoutKids(id);
    const childrenH = cs.reduce((sum, c) => sum + subtreeH(c.id), 0) + Math.max(0, cs.length - 1) * GAP_Y;
    const h = Math.max(size(id).h, childrenH);
    heightMemo.set(id, h);
    return h;
  };

  const pos = new Map<string, { x: number; y: number }>();
  const place = (id: string, x: number, top: number) => {
    const s = size(id);
    const H = subtreeH(id);
    pos.set(id, { x, y: top + (H - s.h) / 2 });
    const cs = layoutKids(id);
    const childrenH = cs.reduce((sum, c) => sum + subtreeH(c.id), 0) + Math.max(0, cs.length - 1) * GAP_Y;
    let y = top + (H - childrenH) / 2;
    for (const c of cs) {
      place(c.id, x + s.w + GAP_X, y);
      y += subtreeH(c.id) + GAP_Y;
    }
  };

  // 自动排的根节点从上到下依次排列
  let y = 0;
  for (const r of roots.filter((r) => !r.pinned)) {
    place(r.id, 0, y);
    y += subtreeH(r.id) + GAP_ROOT;
  }
  // 固定的节点：保持自己的位置，子树在它右侧展开
  for (const id of visible) {
    const n = byId.get(id)!;
    if (!n.pinned) continue;
    const H = subtreeH(id);
    place(id, n.x, n.y - (H - size(id).h) / 2);
  }

  return { pos, depth, branch, childCount, visible, parent };
}
