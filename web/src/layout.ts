import type { BoardEdge, BoardGroup, BoardNode } from "../../server/types.ts";

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
  /** 同列关系线的车道号（越大离卡片越远） */
  lanes: Map<string, number>;
  /** 分组的框（绝对坐标） */
  groups: Map<string, GroupBox>;
  /** 可见节点 → 所在分组 */
  region: Map<string, string>;
}

export interface GroupBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 组内坐标原点（绝对坐标）：组内卡片的 x/y 相对这里 */
  ox: number;
  oy: number;
}

const GAP_X = 72;
const GAP_Y = 14;
const GAP_ROOT = 90;
/** 同列关系弧线：第一条车道离卡片的距离、车道间距、给文字预留的宽度 */
export const LANE_BASE = 26;
export const LANE_STEP = 18;
const LABEL_ROOM = 64;

/** 分组：内边距、标题栏高度、空分组的最小内容区、折叠后的默认尺寸 */
export const GROUP_PAD = 24;
export const GROUP_HEAD = 40;
const GROUP_MIN = { w: 280, h: 90 };
export const GROUP_FOLDED = { w: 280, h: 92 };
export const groupKey = (id: string) => `group:${id}`;

export const widthOf = (depth: number) => (depth === 0 ? 320 : depth === 1 ? 290 : 270);

/**
 * 兄弟节点排序：有关系线相连的兄弟排在一起（沿关系链依次排开），
 * 这样同列之间的关系弧线短、不跨过其他卡片。
 */
function orderByRelations(list: BoardNode[], adj: Map<string, Set<string>>): BoardNode[] {
  const ids = new Set(list.map((n) => n.id));
  const byId = new Map(list.map((n) => [n.id, n]));
  const out: BoardNode[] = [];
  const placed = new Set<string>();
  for (const start of list) {
    if (placed.has(start.id)) continue;
    const queue = [start.id];
    placed.add(start.id);
    while (queue.length) {
      const id = queue.shift()!;
      out.push(byId.get(id)!);
      const next = [...(adj.get(id) ?? [])].filter((x) => ids.has(x) && !placed.has(x));
      next.sort((a, b) => byId.get(a)!.createdAt - byId.get(b)!.createdAt);
      for (const x of next) {
        placed.add(x);
        queue.push(x);
      }
    }
  }
  return out;
}

/**
 * 思维导图布局：根在左，子节点在右侧纵向排开，父节点相对子树垂直居中。
 * 手动固定（pinned）的节点以自己的位置为起点单独排它的子树。
 */
export function layoutTree(
  nodes: BoardNode[],
  sizes: Map<string, Size>,
  edges: BoardEdge[] = [],
  groupList: BoardGroup[] = [],
): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groupById = new Map(groupList.map((g) => [g.id, g]));
  const kids = new Map<string | null, BoardNode[]>();
  for (const n of nodes) {
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(n);
  }
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  for (const [k, list] of kids) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    kids.set(k, orderByRelations(list, adj));
  }

  const depth = new Map<string, number>();
  const branch = new Map<string, number>();
  const childCount = new Map<string, number>();
  const parent = new Map<string, string>();
  const region = new Map<string, string>();
  const visible: string[] = [];
  let branchSeq = 0;

  const visit = (n: BoardNode, d: number, b: number, g: string | undefined) => {
    depth.set(n.id, d);
    branch.set(n.id, b);
    if (g) region.set(n.id, g);
    visible.push(n.id);
    const cs = kids.get(n.id) ?? [];
    childCount.set(n.id, cs.length);
    if (n.fold) return;
    for (const c of cs) {
      parent.set(c.id, n.id);
      visit(c, d + 1, d === 0 ? branchSeq++ : b, g);
    }
  };
  const roots = kids.get(null) ?? [];
  const groupOf = (r: BoardNode) => (r.groupId && groupById.has(r.groupId) ? r.groupId : undefined);
  for (const r of roots) {
    const g = groupOf(r);
    // 折叠的分组里的卡片不显示
    if (g && groupById.get(g)!.fold) continue;
    visit(r, 0, -1, g);
  }

  // 同一列（同深度且都未固定）的关系线：按纵向区间分配车道，互不重叠的可以共用一条
  const order = new Map(visible.map((id, i) => [id, i]));
  const lanes = new Map<string, number>();
  const lanesPerDepth = new Map<number, number>();
  const sameColumn = edges
    .filter((e) => order.has(e.source) && order.has(e.target))
    .filter((e) => depth.get(e.source) === depth.get(e.target) && !byId.get(e.source)!.pinned && !byId.get(e.target)!.pinned)
    .filter((e) => region.get(e.source) === region.get(e.target))
    .map((e) => {
      const [a, b] = [order.get(e.source)!, order.get(e.target)!].sort((x, y) => x - y);
      return { e, a, b, d: depth.get(e.source)! };
    })
    .sort((x, y) => x.b - x.a - (y.b - y.a));
  const used = new Map<string, [number, number][]>();
  for (const r of sameColumn) {
    let lane = 0;
    while ((used.get(`${r.d}:${lane}`) ?? []).some(([a, b]) => r.a <= b && a <= r.b)) lane++;
    const key = `${r.d}:${lane}`;
    used.set(key, [...(used.get(key) ?? []), [r.a, r.b]]);
    lanes.set(r.e.id, lane);
    lanesPerDepth.set(r.d, Math.max(lanesPerDepth.get(r.d) ?? 0, lane + 1));
  }
  const gapAfter = (d: number) => {
    const n = lanesPerDepth.get(d) ?? 0;
    return GAP_X + (n ? LANE_BASE + (n - 1) * LANE_STEP + LABEL_ROOM : 0);
  };

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
      place(c.id, x + s.w + gapAfter(depth.get(id) ?? 0), y);
      y += subtreeH(c.id) + GAP_Y;
    }
  };

  /** 排一片区域（未分组 / 某个分组）里固定位置的节点：保持自己的位置，子树在它右侧展开 */
  const placePinned = (g: string | undefined) => {
    for (const id of visible) {
      const n = byId.get(id)!;
      if (!n.pinned || region.get(id) !== g) continue;
      const H = subtreeH(id);
      place(id, n.x, n.y - (H - size(id).h) / 2);
    }
  };

  // 1. 每个分组内部单独排版（组内坐标），再算出框的范围
  const rel = new Map<string, { left: number; top: number; w: number; h: number }>();
  for (const g of groupList) {
    if (g.fold) {
      const s = sizes.get(groupKey(g.id)) ?? GROUP_FOLDED;
      rel.set(g.id, { left: -GROUP_PAD, top: -GROUP_PAD - GROUP_HEAD, w: s.w, h: s.h });
      continue;
    }
    let y = 0;
    for (const r of roots.filter((r) => groupOf(r) === g.id && !r.pinned)) {
      place(r.id, 0, y);
      y += subtreeH(r.id) + GAP_ROOT;
    }
    placePinned(g.id);
    let [x0, y0, x1, y1] = [0, 0, GROUP_MIN.w, GROUP_MIN.h];
    for (const id of visible) {
      if (region.get(id) !== g.id) continue;
      const p = pos.get(id)!;
      const s = size(id);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + s.w);
      y1 = Math.max(y1, p.y + s.h);
    }
    rel.set(g.id, {
      left: x0 - GROUP_PAD,
      top: y0 - GROUP_PAD - GROUP_HEAD,
      w: x1 - x0 + GROUP_PAD * 2,
      h: y1 - y0 + GROUP_PAD * 2 + GROUP_HEAD,
    });
  }

  // 2. 顶层：没固定的分组和未分组的主题一起从上到下排列，分组当成一整块
  const origin = new Map<string, { x: number; y: number }>();
  const stack = [
    ...roots.filter((r) => !groupOf(r) && !r.pinned).map((r) => ({ key: r.createdAt, root: r, group: undefined })),
    ...groupList.filter((g) => !g.pinned).map((g) => ({ key: g.order, root: undefined, group: g })),
  ].sort((a, b) => a.key - b.key);
  let y = 0;
  for (const item of stack) {
    if (item.root) {
      place(item.root.id, 0, y);
      y += subtreeH(item.root.id) + GAP_ROOT;
    } else {
      const r = rel.get(item.group!.id)!;
      origin.set(item.group!.id, { x: -r.left, y: y - r.top });
      y += r.h + GAP_ROOT;
    }
  }
  for (const g of groupList) if (g.pinned) origin.set(g.id, { x: g.x, y: g.y });
  placePinned(undefined);

  // 3. 组内坐标 → 绝对坐标
  const groups = new Map<string, GroupBox>();
  for (const g of groupList) {
    const o = origin.get(g.id)!;
    const r = rel.get(g.id)!;
    groups.set(g.id, { x: o.x + r.left, y: o.y + r.top, w: r.w, h: r.h, ox: o.x, oy: o.y });
  }
  for (const [id, g] of region) {
    const p = pos.get(id)!;
    const o = origin.get(g)!;
    pos.set(id, { x: p.x + o.x, y: p.y + o.y });
  }

  return { pos, depth, branch, childCount, visible, parent, lanes, groups, region };
}
