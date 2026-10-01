import type { BoardEdge, BoardGroup, BoardNode, NodeSide } from "../../server/types.ts";

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
  /** 节点相对父节点的位置（根节点为 right） */
  side: Map<string, NodeSide>;
  /** 向左展开的节点（子树镜像）；下边的节点跟随父节点 */
  mirror: Map<string, boolean>;
  /** 顶层的主题（节点 id）和分组（groupKey）实际排在第几列；顶层有固定位置的东西时为空 */
  cols: Map<string, number>;
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
/** 放在下边的节点：与父节点的垂直间距、向内缩进 */
const GAP_B = 22;
export const INDENT = 36;
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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 子树的形状：[节点, 相对 x, 相对 y] 和所有卡片的矩形（相对子树根节点的左上角） */
interface Shape {
  pos: [string, number, number][];
  rects: Rect[];
}

/**
 * 把一组矩形（整体右移 dx）往下放：返回最小的下移量，
 * 让它和 placed 里横向有交叠的矩形之间都至少隔 GAP_Y，且不小于 floor。
 */
function clearBelow(placed: Rect[], rects: Rect[], dx: number, floor: number): number {
  let y = floor;
  for (const r of rects) {
    const x0 = r.x + dx;
    const x1 = x0 + r.w;
    for (const a of placed) {
      if (x0 < a.x + a.w && a.x < x1) y = Math.max(y, a.y + a.h + GAP_Y - r.y);
    }
  }
  return y;
}

/** 顶层分列：列间距、期望的整体宽高比（接近常见屏幕）、最多几列 */
const GAP_COL = 160;
const ASPECT = 16 / 10;
const MAX_COLS = 6;

/**
 * 按顺序把顶层的块切成若干列（每列高度尽量接近），
 * 选整体宽高比最接近 ASPECT 的列数；差不多时列数少的优先。
 */
function packColumns<T extends { lo: number; hi: number; h: number }>(items: T[], maxCols: number): T[][] {
  const total = items.reduce((s, it) => s + it.h + GAP_ROOT, 0) - GAP_ROOT;
  let best: { cols: T[][]; score: number } | undefined;
  for (let k = 1; k <= Math.min(maxCols, items.length); k++) {
    const target = total / k;
    const cols: T[][] = [];
    let cur: T[] = [];
    let h = 0;
    items.forEach((it, i) => {
      // 剩下的块不够分给剩下的列时也要换列；超过目标高度一半以上就换列
      const left = items.length - i;
      const need = k - cols.length - 1;
      if (cur.length && (left <= need || h + it.h / 2 > target) && cols.length < k - 1) {
        cols.push(cur);
        cur = [];
        h = 0;
      }
      cur.push(it);
      h += it.h + GAP_ROOT;
    });
    if (cur.length) cols.push(cur);
    const w = cols.reduce((s, c) => s + Math.max(...c.map((it) => it.hi)) - Math.min(...c.map((it) => it.lo)), 0) + (cols.length - 1) * GAP_COL;
    const hh = Math.max(...cols.map((c) => c.reduce((s, it) => s + it.h + GAP_ROOT, 0) - GAP_ROOT));
    // 宽高比偏离的程度（对数，过宽过窄对称）；多一列要明显更好才换
    const score = Math.abs(Math.log(w / hh / ASPECT)) + 0.05 * k;
    if (!best || score < best.score) best = { cols, score };
  }
  return best?.cols ?? [];
}

/** 按已经定下来的列号分列；没有列号的（新建的）排到最后一列末尾 */
function storedColumns<T extends { col?: number }>(items: T[]): T[][] {
  const last = Math.max(...items.map((it) => it.col ?? -Infinity));
  const by = new Map<number, T[]>();
  for (const it of items) {
    const c = it.col ?? last;
    if (!by.has(c)) by.set(c, []);
    by.get(c)!.push(it);
  }
  return [...by.keys()].sort((a, b) => a - b).map((c) => by.get(c)!);
}

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
 * 顶层按主题 / 分组上存的列号分列；都没有列号或 repack 时重新计算分列。
 */
export function layoutTree(
  nodes: BoardNode[],
  sizes: Map<string, Size>,
  edges: BoardEdge[] = [],
  groupList: BoardGroup[] = [],
  { repack = false }: { repack?: boolean } = {},
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

  const side = new Map<string, NodeSide>();
  const mirror = new Map<string, boolean>();
  /** 一路向右展开（同一列的卡片 x 对齐，关系线才能用车道） */
  const pure = new Map<string, boolean>();

  const visit = (n: BoardNode, d: number, b: number, g: string | undefined) => {
    depth.set(n.id, d);
    branch.set(n.id, b);
    if (g) region.set(n.id, g);
    visible.push(n.id);
    const cs = kids.get(n.id) ?? [];
    childCount.set(n.id, cs.length);
    if (n.fold) return;
    const mir = mirror.get(n.id) ?? false;
    for (const c of cs) {
      parent.set(c.id, n.id);
      const s: NodeSide = c.side ?? (mir ? "left" : "right");
      side.set(c.id, s);
      mirror.set(c.id, s === "left" ? true : s === "right" ? false : mir);
      pure.set(c.id, s === "right" && !!pure.get(n.id));
      visit(c, d + 1, d === 0 ? branchSeq++ : b, g);
    }
  };
  const roots = kids.get(null) ?? [];
  const groupOf = (r: BoardNode) => (r.groupId && groupById.has(r.groupId) ? r.groupId : undefined);
  for (const r of roots) {
    const g = groupOf(r);
    // 折叠的分组里的卡片不显示
    if (g && groupById.get(g)!.fold) continue;
    side.set(r.id, "right");
    mirror.set(r.id, false);
    pure.set(r.id, true);
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
    .filter((e) => pure.get(e.source) && pure.get(e.target))
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
  /** 按位置把子节点分成右 / 左 / 下三组 */
  const parts = (id: string) => {
    const all = layoutKids(id);
    const by = (s: NodeSide) => all.filter((c) => side.get(c.id) === s);
    return { r: by("right"), l: by("left"), b: by("bottom") };
  };

  /**
   * 子树的形状：所有卡片相对该节点左上角的位置和矩形。
   * 兄弟子树按轮廓贴紧排列：只有横向有交叠的卡片之间才需要留间距，
   * 所以浅的子树可以塞进深的子树旁边空出来的地方，而不是整块往下排。
   */
  const shapeMemo = new Map<string, Shape>();
  const shape = (id: string): Shape => {
    const cached = shapeMemo.get(id);
    if (cached) return cached;
    const s = size(id);
    const p = parts(id);
    const gap = gapAfter(depth.get(id) ?? 0);
    const out: Shape = { pos: [[id, 0, 0]], rects: [{ x: 0, y: 0, w: s.w, h: s.h }] };
    const add = (sh: Shape, dx: number, dy: number) => {
      for (const [cid, x, y] of sh.pos) out.pos.push([cid, x + dx, y + dy]);
      for (const r of sh.rects) out.rects.push({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
    };
    /** 一列兄弟依次往下贴紧；首尾两张卡片的中线对齐父节点的中线 */
    const column = (cs: BoardNode[], xOf: (c: BoardNode) => number) => {
      if (!cs.length) return;
      const acc: Rect[] = [];
      const placed: { sh: Shape; x: number; y: number }[] = [];
      for (const c of cs) {
        const sh = shape(c.id);
        const x = xOf(c);
        const y = placed.length ? clearBelow(acc, sh.rects, x, -Infinity) : 0;
        for (const r of sh.rects) acc.push({ x: r.x + x, y: r.y + y, w: r.w, h: r.h });
        placed.push({ sh, x, y });
      }
      const last = placed[placed.length - 1]!;
      const dy = s.h / 2 - (last.y + size(cs[cs.length - 1]!.id).h) / 2;
      for (const q of placed) add(q.sh, q.x, q.y + dy);
    };
    column(p.r, () => s.w + gap);
    column(p.l, (c) => -GAP_X - size(c.id).w);
    // 下边的节点：贴着父节点往下排，同时避开左右两侧已经排好的子树
    let floor = s.h + GAP_B;
    for (const c of p.b) {
      const sh = shape(c.id);
      const x = mirror.get(id) ? s.w - INDENT - size(c.id).w : INDENT;
      const y = clearBelow(out.rects, sh.rects, x, floor);
      add(sh, x, y);
      floor = -Infinity;
    }
    shapeMemo.set(id, out);
    return out;
  };
  const bounds = (id: string) => {
    let [top, bottom, left, right] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const r of shape(id).rects) {
      top = Math.min(top, r.y);
      bottom = Math.max(bottom, r.y + r.h);
      left = Math.min(left, r.x);
      right = Math.max(right, r.x + r.w);
    }
    return { top, h: bottom - top, left, right };
  };

  const pos = new Map<string, { x: number; y: number }>();
  /** 把节点（连同子树）的左上角放到 (x, y) */
  const place = (id: string, x: number, y: number) => {
    for (const [cid, dx, dy] of shape(id).pos) pos.set(cid, { x: x + dx, y: y + dy });
  };
  /** 把整棵子树的上沿放到 top */
  const placeTop = (id: string, x: number, top: number) => {
    place(id, x, top - bounds(id).top);
    return bounds(id).h;
  };

  /** 排一片区域（未分组 / 某个分组）里固定位置的节点：保持自己的位置，子树在它右侧展开 */
  const placePinned = (g: string | undefined) => {
    for (const id of visible) {
      const n = byId.get(id)!;
      if (!n.pinned || region.get(id) !== g) continue;
      place(id, n.x, n.y);
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
      y += placeTop(r.id, 0, y) + GAP_ROOT;
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

  // 2. 顶层：没固定的分组和未分组的主题按顺序分成几列（先上下、再左右），
  //    列数让整体宽高比接近屏幕，避免很多棵树叠成一长条；分组当成一整块
  const origin = new Map<string, { x: number; y: number }>();
  const stack = [
    ...roots
      .filter((r) => !groupOf(r) && !r.pinned)
      .map((r) => ({ key: r.createdAt, id: r.id, col: r.col, root: r, group: undefined })),
    ...groupList
      .filter((g) => !g.pinned)
      .map((g) => ({ key: g.order, id: groupKey(g.id), col: g.col, root: undefined, group: g })),
  ]
    .sort((a, b) => a.key - b.key)
    .map((item) => {
      // 锚点：主题是根卡片的左边，分组是框的左边；lo / hi 是相对锚点的左右范围
      if (item.root) {
        const b = bounds(item.root.id);
        return { ...item, lo: b.left, hi: b.right, h: b.h };
      }
      const r = rel.get(item.group!.id)!;
      return { ...item, lo: 0, hi: r.w, h: r.h };
    });
  // 顶层有手动固定的卡片或分组时只排一列：它们按绝对坐标摆放，分列会让别的树挪到它们身上
  const fixed = groupList.some((g) => g.pinned) || visible.some((id) => byId.get(id)!.pinned && !region.has(id));
  const columns = fixed
    ? stack.length
      ? [stack]
      : []
    : !repack && stack.some((it) => it.col !== undefined)
      ? storedColumns(stack)
      : packColumns(stack, MAX_COLS);
  const cols = new Map<string, number>();
  if (!fixed) columns.forEach((col, i) => col.forEach((it) => cols.set(it.id, i)));
  let colStart = Math.min(0, ...(columns[0] ?? []).map((it) => it.lo));
  for (const col of columns) {
    const lo = Math.min(...col.map((it) => it.lo));
    const x = colStart - lo;
    let y = 0;
    for (const item of col) {
      if (item.root) {
        placeTop(item.root.id, x, y);
      } else {
        const r = rel.get(item.group!.id)!;
        origin.set(item.group!.id, { x: x - r.left, y: y - r.top });
      }
      y += item.h + GAP_ROOT;
    }
    colStart = x + Math.max(...col.map((it) => it.hi)) + GAP_COL;
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

  return { pos, depth, branch, childCount, visible, parent, lanes, groups, region, side, mirror, cols };
}
