import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  MarkerType,
  Panel,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type CoordinateExtent,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import type { BoardEdge, BoardNode } from "../../server/types.ts";
import { animator } from "./animator.ts";
import { client, type ClientState } from "./client.ts";
import { GROUP_HEAD, GROUP_PAD, groupKey, layoutTree, type Size } from "./layout.ts";
import { GroupNode, type GroupFlowNode } from "./GroupNode.tsx";
import { MdNode, type MdFlowNode } from "./MdNode.tsx";
import { diffBoards, fullText } from "./compare.ts";
import { RelationEdge } from "./RelationEdge.tsx";
import { RelationForm } from "./RelationForm.tsx";
import { ui, type MenuItem } from "./ui.ts";
import { TagBar, TagForm } from "./Tags.tsx";

const nodeTypes = { md: MdNode, group: GroupNode };
type FlowNode = MdFlowNode | GroupFlowNode;
/** 分组里的卡片能到达的范围（相对分组的框）：左边和上边有界，右边和下边拖过去框会撑大 */
const CARD_EXTENT: CoordinateExtent = [
  [8, GROUP_HEAD + 4],
  [Infinity, Infinity],
];
const isGroup = (n: { type?: string }) => n.type === "group";
const groupIdOf = (rfId: string) => rfId.slice("group:".length);
const edgeTypes = { relation: RelationEdge };
const REL_COLOR = "#8b93a3";
const arrow = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: REL_COLOR };
const titleOf = (n?: BoardNode) => n?.title || n?.summary.slice(0, 12) || "未命名";
export const BRANCH_COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e", "#73daca", "#ff9e64"];
const ROOT_COLOR = "#c0caf5";

export const colorOf = (branch: number) => (branch < 0 ? ROOT_COLOR : BRANCH_COLORS[branch % BRANCH_COLORS.length]);

interface Props {
  state: ClientState;
  follow: boolean;
  detail: "summary" | "full";
  onSelectionChange: (ids: string[]) => void;
}

export function Canvas({ state, follow, detail, onSelectionChange }: Props) {
  const rf = useReactFlow<FlowNode>();
  const [rfNodes, setRfNodes] = useState<FlowNode[]>([]);
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** 卡片拖进 / 换到的分组 */
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  /** 在分组里拖到右边或下边时，框跟着撑大 */
  const [dragBox, setDragBox] = useState<{ gid: string; w: number; h: number } | null>(null);
  /** 按住 ⌥ 时卡片不受分组的框限制 */
  const [altHeld, setAltHeld] = useState(false);
  const followRef = useRef(follow);
  followRef.current = follow;
  /** 用户在 AI 工作期间手动移动 / 缩放过画布：本轮不再自动居中，播完后恢复 */
  const userMovedRef = useRef(false);

  const nodes = useMemo(() => [...state.nodes.values()], [state.nodes]);
  // AI 正在准备修改的节点（工具参数还在生成中）。
  // 对话每个 token 都会更新，这里先算成字符串再 memo，避免每个 token 都让所有节点重建
  const pendingKey = (() => {
    const ids: string[] = [];
    const last = state.chat.at(-1);
    if (state.busy && last?.role === "ai") {
      for (const a of last.activity ?? []) {
        if (a.status === "running" && a.nodeId && a.tool !== "canvas_read") ids.push(a.nodeId);
      }
    }
    for (const t of state.tasks.values()) {
      if (t.status !== "running") continue;
      for (const a of t.activity) if (a.status === "running" && a.nodeId && a.tool !== "canvas_read") ids.push(a.nodeId);
    }
    return ids.sort().join(",");
  })();
  const pendingIds = useMemo(() => new Set(pendingKey ? pendingKey.split(",") : []), [pendingKey]);
  const edgeList = useMemo(() => [...state.edges.values()], [state.edges]);
  // 版本对比：当前白板相对历史版本的变化
  const diff = useMemo(
    () => (state.compare ? diffBoards(state.compare.board, nodes, edgeList) : null),
    [state.compare, nodes, edgeList],
  );
  const groupList = useMemo(() => [...state.groups.values()].sort((a, b) => a.createdAt - b.createdAt), [state.groups]);
  const layout = useMemo(() => layoutTree(nodes, sizes, edgeList, groupList), [nodes, sizes, edgeList, groupList]);
  // 每个分组的主题标题和卡片数（折叠后显示）
  const groupStats = useMemo(() => {
    const stats = new Map<string, { topics: string[]; cards: number }>();
    for (const g of groupList) stats.set(g.id, { topics: [], cards: 0 });
    const rootGroup = (n: BoardNode) => {
      let r = n;
      for (let p = r.parentId && state.nodes.get(r.parentId); p; p = p.parentId && state.nodes.get(p.parentId)) r = p;
      return r.groupId;
    };
    for (const n of [...nodes].sort((a, b) => a.createdAt - b.createdAt)) {
      const st = stats.get(rootGroup(n) ?? "");
      if (!st) continue;
      st.cards++;
      if (!n.parentId) st.topics.push(titleOf(n));
    }
    return stats;
  }, [nodes, groupList, state.nodes]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** 节点不在视野内时平滑移过去；已经可见就不动镜头 */
  const ensureVisible = useCallback(
    async (id: string, force = false) => {
      if (!force && (!followRef.current || userMovedRef.current)) return;
      // 在折叠的分支里：先展开祖先
      let root = client.state.nodes.get(id);
      for (let n = root; n?.parentId; n = client.state.nodes.get(n.parentId)) {
        const p = client.state.nodes.get(n.parentId);
        if (p?.fold) client.patchNode(p.id, { fold: false });
        if (p) root = p;
      }
      // 在折叠的分组里：展开分组
      const g = root?.groupId ? client.state.groups.get(root.groupId) : undefined;
      if (g?.fold) client.patchGroup(g.id, { fold: false });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const p = layoutRef.current.pos.get(id);
      if (!p) return;
      const s = sizes.get(id) ?? { w: 300, h: 80 };
      const { x: vx, y: vy, zoom } = rf.getViewport();
      const el = document.querySelector(".react-flow");
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const left = p.x * zoom + vx;
      const top = p.y * zoom + vy;
      const margin = 60;
      const visible =
        left >= margin && top >= margin && left + s.w * zoom <= width - margin && top + Math.min(s.h, 260) * zoom <= height - 140;
      if (visible && !force) return;
      await rf.setCenter(p.x + s.w / 2, p.y + Math.min(s.h, 260) / 2, { zoom: Math.max(zoom, 0.75), duration: 480 });
    },
    [rf, sizes],
  );

  useEffect(() => {
    animator.focus = (id) => ensureVisible(id);
    animator.onIdle = () => {
      userMovedRef.current = false;
    };
    ui.focusNode = (id) => {
      setRfNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
      onSelectionChange([id]);
      ensureVisible(id, true);
    };
  }, [ensureVisible, onSelectionChange]);

  // 选中高亮：选中节点 → 它的父子、关系线和相连节点；选中关系线 → 两端节点
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const selNodesKey = rfNodes
    .filter((n) => n.selected)
    .map((n) => n.id)
    .join(",");
  const focus = useMemo(() => {
    const selNodes = selNodesKey ? selNodesKey.split(",") : [];
    if (!selNodes.length && !selEdges.length) return null;
    const nodes = new Set<string>();
    const edges = new Set<string>();
    for (const id of selNodes) {
      nodes.add(id);
      const parent = layout.parent.get(id);
      if (parent) {
        nodes.add(parent);
        edges.add(`t-${id}`);
      }
      for (const [child, p] of layout.parent) {
        if (p === id) {
          nodes.add(child);
          edges.add(`t-${child}`);
        }
      }
      for (const e of edgeList) {
        if (e.source === id || e.target === id) {
          edges.add(e.id);
          nodes.add(e.source);
          nodes.add(e.target);
        }
      }
    }
    for (const eid of selEdges) {
      const e = state.edges.get(eid);
      if (!e) continue;
      edges.add(e.id);
      nodes.add(e.source);
      nodes.add(e.target);
    }
    return { nodes, edges, primary: new Set(selNodes) };
  }, [selNodesKey, selEdges, layout, edgeList, state.edges]);
  const focusKey = focus ? [...focus.nodes].sort().join(",") : "";

  // 状态 + 布局 → React Flow 节点，保留选中、测量、拖动中的状态
  useEffect(() => {
    setRfNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      // 分组框：要排在组内卡片前面（React Flow 要求父节点在前）
      const groupNodes: GroupFlowNode[] = groupList.map((g, i) => {
        const id = groupKey(g.id);
        const box = layout.groups.get(g.id)!;
        const p = prevMap.get(id) as GroupFlowNode | undefined;
        const stats = groupStats.get(g.id)!;
        const data: GroupFlowNode["data"] = {
          group: g,
          color: colorOf(i + 3),
          topics: stats.topics,
          cards: stats.cards,
          dropTarget: dropGroup === g.id,
        };
        const grow = dragBox?.gid === g.id ? dragBox : undefined;
        const width = g.fold ? undefined : Math.max(box.w, grow?.w ?? 0);
        const height = g.fold ? undefined : Math.max(box.h, grow?.h ?? 0);
        const position = p?.dragging ? p.position : { x: box.x, y: box.y };
        if (
          p &&
          shallowEqual(p.data, data) &&
          p.position.x === position.x &&
          p.position.y === position.y &&
          p.style?.width === width &&
          p.style?.height === height
        )
          return p;
        return {
          id,
          type: "group",
          position,
          data,
          style: g.fold ? {} : { width, height },
          dragHandle: ".group-head",
          selectable: false,
          deletable: false,
          connectable: false,
          dragging: p?.dragging,
          measured: g.fold ? p?.measured : undefined,
        };
      });
      const cards = layout.visible.map((id): MdFlowNode => {
        const n = state.nodes.get(id)!;
        const p = prevMap.get(id) as MdFlowNode | undefined;
        const depth = layout.depth.get(id) ?? 0;
        const data: MdFlowNode["data"] = {
          node: n,
          depth,
          color: colorOf(layout.branch.get(id) ?? -1),
          childCount: layout.childCount.get(id) ?? 0,
          detail,
          dropTarget: dropTarget === id,
          pending: pendingIds.has(id),
          mirror: layout.mirror.get(id) ?? false,
          dim: (!!focus && !focus.nodes.has(id)) || (!!state.tagFilter && !n.tags?.includes(state.tagFilter)),
          related: !!focus && focus.nodes.has(id) && !focus.primary.has(id),
          diff: diff?.nodes.get(id),
          beforeText: diff?.nodes.get(id) === "modified" ? fullText(diff.before.get(id)!) : undefined,
        };
        // 分组里的卡片：坐标相对分组的框，拖动时不能越过框的左边和上边（按住 ⌥ 除外）
        const gid = layout.region.get(id);
        const box = gid ? layout.groups.get(gid) : undefined;
        const abs = layout.pos.get(id)!;
        const position = p?.dragging ? p.position : box ? { x: abs.x - box.x, y: abs.y - box.y } : abs;
        const parentId = gid ? groupKey(gid) : undefined;
        const extent = gid && !altHeld ? CARD_EXTENT : undefined;
        // 内容和位置都没变时复用原对象，让 memo(MdNode) 生效
        if (
          p &&
          shallowEqual(p.data, data) &&
          p.position.x === position.x &&
          p.position.y === position.y &&
          p.parentId === parentId &&
          p.extent === extent
        )
          return p;
        return {
          id,
          type: "md",
          position,
          parentId,
          extent,
          data,
          selected: p?.selected ?? false,
          dragging: p?.dragging,
          measured: p?.measured,
          className: p ? undefined : "enter",
        };
      });
      return [...groupNodes, ...cards];
    });
    // 用 focusKey 而不是 focus 作依赖：只有高亮的节点集合变了才需要重建
  }, [state.nodes, layout, detail, dropTarget, pendingIds, focusKey, diff, groupList, groupStats, dropGroup, dragBox, altHeld, state.tagFilter]);

  const edges: Edge[] = useMemo(() => {
    const tree: Edge[] = [];
    for (const [child, parent] of layout.parent) {
      // 连线从父节点朝向孩子的那一侧出发
      const s = layout.side.get(child) ?? "right";
      const mir = layout.mirror.get(child) ?? false;
      const handles =
        s === "left"
          ? { sourceHandle: "l", targetHandle: "tr" }
          : s === "bottom"
            ? { sourceHandle: layout.mirror.get(parent) ? "bm" : "b", targetHandle: mir ? "tr" : "tl" }
            : { sourceHandle: "r", targetHandle: "tl" };
      tree.push({
        id: `t-${child}`,
        source: parent,
        target: child,
        ...handles,
        className: `tree-edge ${edgeState(focus, `t-${child}`)}`,
        style: { stroke: colorOf(layout.branch.get(child) ?? -1) },
        selectable: false,
        focusable: false,
      });
    }
    const shown = new Set(layout.visible);
    const links: Edge[] = edgeList
      .filter((e) => shown.has(e.source) && shown.has(e.target))
      .map((e) => ({
        id: e.id,
        type: "relation",
        source: e.source,
        target: e.target,
        className: `rel-edge ${edgeState(focus, e.id)}`,
        selected: selEdges.includes(e.id),
        markerEnd: arrow,
        markerStart: arrow,
        data: {
          edge: e,
          sourceTitle: titleOf(state.nodes.get(e.source)),
          targetTitle: titleOf(state.nodes.get(e.target)),
          lane: layout.lanes.get(e.id) ?? 0,
          state: edgeState(focus, e.id),
        },
      }));
    return [...tree, ...links];
  }, [layout, edgeList, state.nodes, focus, selEdges]);

  const nodeMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const n = client.state.nodes.get(id);
    if (!n) return;
    const selected = rf.getNodes().filter((x) => x.selected).map((x) => x.id);
    const multi = selected.length > 1 && selected.includes(id);
    const gid = layout.region.get(id);
    const groupItems: MenuItem[] = [
      { label: "放进新分组", hint: "⌘G", onClick: () => client.createGroup([id]) },
      ...groupList
        .filter((g) => g.id !== gid)
        .map((g) => ({
          label: `移到分组「${g.title || "未命名分组"}」`,
          onClick: () => client.send({ type: "node:toGroup", id, groupId: g.id }),
        })),
      ...(gid ? [{ label: "移出分组", onClick: () => client.send({ type: "node:toGroup", id, groupId: null }) }] : []),
    ];
    const items: MenuItem[] = multi
      ? [
          { title: `已选中 ${selected.length} 个节点` },
          { label: "让 AI 处理这些节点…", hint: "推荐", onClick: () => ui.focusComposer(`想让 AI 怎么处理这 ${selected.length} 个节点？`) },
          { label: "打包成分组", hint: "⌘G", onClick: () => client.createGroup(selected) },
          ...(n.parentId
            ? [
                { title: "放在父节点的" },
                ...(["auto", "left", "right", "bottom"] as const).map((s) => ({
                  label: { auto: "跟随父级", left: "左边", right: "右边", bottom: "下边" }[s],
                  hint: (n.side ?? "auto") === s ? "✓" : undefined,
                  onClick: () => client.patchNode(id, { side: s, ...(n.pinned ? { pinned: false } : {}) }),
                })),
                { sep: true as const },
              ]
            : []),
          { label: "标签…", onClick: () => ui.openMenu({ x: e.clientX, y: e.clientY, items: [], form: <TagForm ids={selected} /> }) },
          { sep: true },
          { label: `删除 ${selected.length} 个节点`, danger: true, onClick: () => selected.forEach((sid) => client.send({ type: "node:delete", id: sid })) },
        ]
      : [
          { title: titleOf(n) },
          { label: "让 AI 改这个节点…", hint: "推荐", onClick: () => ui.askAI(id, titleOf(n)) },
          { sep: true },
          { label: "查看详情", hint: "Space", onClick: () => ui.openDetail(id) },
          ...(n.md.trim() && detail === "summary"
            ? [
                {
                  label: n.kind === "widget" ? (n.open ? "收起组件" : "运行组件") : n.open ? "收起正文" : "展开正文",
                  hint: "双击",
                  onClick: () => client.patchNode(id, { open: !n.open }),
                },
              ]
            : []),
          ...((layout.childCount.get(id) ?? 0) > 0
            ? [{ label: n.fold ? "展开分支" : "折叠分支", onClick: () => client.patchNode(id, { fold: !n.fold }) }]
            : []),
          { label: n.kind === "widget" ? "编辑代码" : "手动编辑", onClick: () => ui.requestEdit(id) },
          { label: "标签…", onClick: () => ui.openMenu({ x: e.clientX, y: e.clientY, items: [], form: <TagForm ids={[id]} /> }) },
          { label: "添加子节点", hint: "Tab", onClick: () => client.createNode(id) },
          { label: "添加同级节点", hint: "⇧Tab", onClick: () => createSibling(n) },
          ...(n.pinned ? [{ label: "恢复自动排版", onClick: () => client.patchNode(id, { pinned: false }) }] : []),
          ...(n.parentId ? [{ label: "变成独立主题", onClick: () => client.patchNode(id, { parentId: null }) }] : []),
          { sep: true },
          ...groupItems,
          { sep: true },
          { label: "删除", danger: true, hint: "⌫", onClick: () => client.send({ type: "node:delete", id }) },
        ];
    ui.openMenu({ x: e.clientX, y: e.clientY, items });
  };

  const groupMenu = (e: React.MouseEvent, gid: string) => {
    e.preventDefault();
    const g = client.state.groups.get(gid);
    if (!g) return;
    const box = layout.groups.get(gid);
    ui.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { title: g.title || "未命名分组" },
        { label: "让 AI 整理这个分组…", hint: "推荐", onClick: () => ui.focusComposer(`想让 AI 怎么整理分组「${g.title}」？`) },
        { sep: true },
        { label: "重命名", hint: "双击标题", onClick: () => ui.requestEdit(groupKey(gid)) },
        { label: g.fold ? "展开分组" : "折叠分组", onClick: () => client.patchGroup(gid, { fold: !g.fold }) },
        ...(!g.fold ? [{ label: "在分组里新建主题", hint: "双击空白", onClick: () => client.createNode(null, undefined, gid) }] : []),
        ...(box
          ? [{ label: "聚焦这个分组", onClick: () => rf.fitBounds({ x: box.x, y: box.y, width: box.w, height: box.h }, { duration: 420, padding: 0.12 }) }]
          : []),
        ...(g.pinned ? [{ label: "恢复自动排列", onClick: () => client.patchGroup(gid, { pinned: false }) }] : []),
        { sep: true },
        { label: "解散分组", hint: "保留卡片", onClick: () => client.send({ type: "group:delete", id: gid, withContent: false }) },
        {
          label: "删除分组及里面的卡片",
          danger: true,
          onClick: () => {
            const n = groupStats.get(gid)?.cards ?? 0;
            if (!n || confirm(`删除分组「${g.title}」和里面的 ${n} 张卡片？可以在版本里找回。`)) {
              client.send({ type: "group:delete", id: gid, withContent: true });
            }
          },
        },
      ],
    });
  };

  /** 同级节点：主题的同级是同一个分组里的新主题 */
  const createSibling = (n: BoardNode) => client.createNode(n.parentId, undefined, n.parentId ? undefined : n.groupId);

  const edgeMenu = (e: React.MouseEvent, edge: BoardEdge) => {
    e.preventDefault();
    const s = titleOf(state.nodes.get(edge.source));
    const t = titleOf(state.nodes.get(edge.target));
    const set = (patch: Partial<BoardEdge>) => client.send({ type: "edge:update", id: edge.id, patch });
    const x = e.clientX;
    const y = e.clientY;
    ui.openMenu({
      x,
      y,
      items: [
        { title: `${s} ${edge.dir === "both" ? "↔" : edge.dir === "none" ? "—" : "→"} ${t}` },
        { label: "编辑关系文字…", onClick: () => ui.openMenu({ x, y, items: [], form: <RelationForm edge={edge} sourceTitle={s} targetTitle={t} /> }) },
        { sep: true },
        ...(edge.dir !== "forward" ? [{ label: "改为单向 →", onClick: () => set({ dir: "forward" }) }] : []),
        ...(edge.dir !== "both" ? [{ label: "改为双向 ↔", onClick: () => set({ dir: "both" }) }] : []),
        ...(edge.dir !== "none" ? [{ label: "去掉箭头", onClick: () => set({ dir: "none" }) }] : []),
        ...(edge.dir === "forward" ? [{ label: "反转方向", onClick: () => client.send({ type: "edge:reverse", id: edge.id }) }] : []),
        { sep: true },
        { label: "删除关系", danger: true, onClick: () => client.send({ type: "edge:delete", id: edge.id }) },
      ],
    });
  };

  const paneMenu = (e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    ui.openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "在这里新建主题", onClick: () => client.createNode(null, { x: Math.round(p.x), y: Math.round(p.y) }) },
        {
          label: "在这里新建分组",
          // 分组原点在内容区左上角：让框的左上角落在点击的位置
          onClick: () => client.createGroup([], { x: Math.round(p.x + GROUP_PAD), y: Math.round(p.y + GROUP_PAD + GROUP_HEAD) }),
        },
        { label: "全览", onClick: () => rf.fitView({ duration: 400, maxZoom: 1 }) },
      ],
    });
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setRfNodes((nds) => {
        const next = applyNodeChanges(changes, nds);
        if (changes.some((c) => c.type === "select")) {
          onSelectionChange(next.filter((n) => n.selected && !isGroup(n)).map((n) => n.id));
        }
        return next;
      });
      const dims = changes.filter((c) => c.type === "dimensions" && c.dimensions);
      if (dims.length) {
        setSizes((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const c of dims) {
            if (c.type !== "dimensions" || !c.dimensions) continue;
            const old = prev.get(c.id);
            const { width: w, height: h } = c.dimensions;
            if (!old || Math.abs(old.w - w) > 1 || Math.abs(old.h - h) > 1) {
              next.set(c.id, { w, h });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    },
    [onSelectionChange],
  );

  /** 拖到另一个节点上 = 挂到它下面 */
  const findDropTarget = (id: string) => {
    const self = rf.getNode(id);
    if (!self) return null;
    const hits = rf.getIntersectingNodes(self).filter((n) => !isGroup(n) && n.id !== id && !isDescendant(n.id, id));
    return hits[0]?.id ?? null;
  };

  /** 卡片中心所在的分组（后面的分组画在上面，优先） */
  const groupAt = (id: string) => {
    const n = rf.getInternalNode(id);
    if (!n) return null;
    const cx = n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2;
    const cy = n.internals.positionAbsolute.y + Math.min(n.measured.height ?? 0, 80) / 2;
    let hit: string | null = null;
    for (const [gid, b] of layout.groups) {
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) hit = gid;
    }
    return hit;
  };

  /** 拖动卡片时要去的分组：在分组里只能留在原分组（按住 ⌥ 才能拖出去），不在分组里则看落点 */
  const destGroup = (id: string, alt: boolean) => {
    const cur = layout.region.get(id) ?? null;
    return cur && !alt ? cur : groupAt(id);
  };

  const onDrag = (e: MouseEvent | TouchEvent, node: FlowNode) => {
    if (isGroup(node)) return;
    const alt = "altKey" in e && e.altKey;
    setDropTarget(findDropTarget(node.id));
    const cur = layout.region.get(node.id) ?? null;
    const dest = destGroup(node.id, alt);
    setDropGroup(dest && dest !== cur ? dest : null);
    // 在分组里拖到右边或下边：框跟着撑大
    const box = cur && !alt ? layout.groups.get(cur) : undefined;
    const m = rf.getInternalNode(node.id)?.measured;
    if (box && m) {
      const w = node.position.x + (m.width ?? 0) + GROUP_PAD;
      const h = node.position.y + Math.min(m.height ?? 0, 400) + GROUP_PAD;
      setDragBox(w > box.w || h > box.h ? { gid: cur!, w, h } : null);
    }
  };

  const onDragStop = (e: MouseEvent | TouchEvent, node: FlowNode) => {
    setDropTarget(null);
    setDropGroup(null);
    setDragBox(null);
    if (isGroup(node)) {
      const gid = groupIdOf(node.id);
      const box = layout.groups.get(gid);
      if (!box) return;
      // 记录分组原点：框的左上角 + 原点相对框的偏移
      client.patchGroup(gid, {
        x: Math.round(node.position.x + box.ox - box.x),
        y: Math.round(node.position.y + box.oy - box.y),
        pinned: true,
      });
      return;
    }
    const target = findDropTarget(node.id);
    if (target) {
      client.patchNode(node.id, { parentId: target, pinned: false });
      return;
    }
    const abs = rf.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
    const cur = layout.region.get(node.id) ?? null;
    const dest = destGroup(node.id, "altKey" in e && e.altKey);
    const box = dest ? layout.groups.get(dest) : undefined;
    const destGroupState = dest ? client.state.groups.get(dest) : undefined;
    // 组内坐标相对分组原点；拖到折叠的分组上则交给自动排版
    const pos = dest && (!box || destGroupState?.fold) ? undefined : { x: Math.round(abs.x - (box?.ox ?? 0)), y: Math.round(abs.y - (box?.oy ?? 0)) };
    if (dest === cur && pos) client.patchNode(node.id, { ...pos, pinned: true });
    else client.send({ type: "node:toGroup", id: node.id, groupId: dest, ...pos });
  };

  const createSiblingRef = useRef(createSibling);
  createSiblingRef.current = createSibling;

  // 快捷键：选中一个节点时 Tab 新建子节点，⇧Tab 新建同级节点；⌘G 打包成分组；Space 弹窗查看卡片详情
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable], button")) return;
      const sel = rf.getNodes().filter((n) => n.selected && !isGroup(n));
      if (!sel.length) return;
      // ⌘G：把选中的卡片打包成分组
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        client.createGroup(sel.map((n) => n.id));
        return;
      }
      // Space：弹窗查看选中卡片的详细内容
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !ui.getMenu()) {
        e.preventDefault();
        const node = client.state.nodes.get(sel[0].id);
        if (node && !node.draft) ui.openDetail(node.id);
        return;
      }
      if (e.key !== "Tab") return;
      if (sel.length !== 1) return;
      e.preventDefault();
      const node = client.state.nodes.get(sel[0].id);
      if (!node) return;
      if (e.shiftKey) createSiblingRef.current(node);
      else client.createNode(node.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf]);

  // 按住 ⌥：分组里的卡片可以拖出框
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltHeld(e.altKey);
    const reset = () => setAltHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={(changes) => {
        const sel = changes.filter((c) => c.type === "select");
        if (!sel.length) return;
        setSelEdges((prev) => {
          const next = new Set(prev);
          for (const c of sel) {
            if (c.type !== "select") continue;
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
          }
          return [...next].filter((id) => !id.startsWith("t-"));
        });
      }}
      onNodeContextMenu={(e, n) => (isGroup(n) ? groupMenu(e, groupIdOf(n.id)) : nodeMenu(e, n.id))}
      onNodeDoubleClick={(e, n) => {
        // 双击分组的空白处：在分组里这个位置新建主题
        if (!isGroup(n) || !(e.target as HTMLElement).closest(".group-body")) return;
        const gid = groupIdOf(n.id);
        const box = layout.groups.get(gid);
        if (!box) return;
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        client.createNode(null, { x: Math.round(p.x - box.ox), y: Math.round(p.y - box.oy) }, gid);
      }}
      onEdgeContextMenu={(e, edge) => {
        const be = state.edges.get(edge.id);
        if (be) edgeMenu(e, be);
        else e.preventDefault();
      }}
      onPaneContextMenu={paneMenu}
      onDoubleClick={(e) => {
        // 双击空白处新建主题（双击节点是展开）
        if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        client.createNode(null, { x: Math.round(p.x), y: Math.round(p.y) });
      }}
      onEdgeDoubleClick={(e, edge) => {
        const be = state.edges.get(edge.id);
        if (!be) return;
        ui.openMenu({
          x: e.clientX,
          y: e.clientY,
          items: [],
          form: (
            <RelationForm
              edge={be}
              sourceTitle={titleOf(state.nodes.get(be.source))}
              targetTitle={titleOf(state.nodes.get(be.target))}
            />
          ),
        });
      }}
      onNodeDrag={onDrag}
      onNodeDragStop={onDragStop}
      onNodesDelete={(ns) => ns.filter((n) => !isGroup(n)).forEach((n) => client.send({ type: "node:delete", id: n.id }))}
      onEdgesDelete={(es) => es.filter((e) => !e.id.startsWith("t-")).forEach((e) => client.send({ type: "edge:delete", id: e.id }))}
      onConnect={(c) => c.source && c.target && client.send({ type: "edge:add", source: c.source, target: c.target })}
      onMoveStart={(e) => {
        // 只有用户操作才带事件；setCenter / fitView 触发的没有
        if (e) userMovedRef.current = true;
      }}
      zoomOnDoubleClick={false}
      deleteKeyCode={["Backspace", "Delete"]}
      multiSelectionKeyCode={["Meta", "Shift"]}
      selectionKeyCode="Shift"
      minZoom={0.15}
      maxZoom={1.6}
      fitView
      fitViewOptions={{ maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      <MiniMap
        pannable
        zoomable
        className="minimap"
        nodeBorderRadius={6}
        nodeColor={(n) => (isGroup(n) ? `${(n.data as GroupFlowNode["data"]).color}33` : (n.data as MdFlowNode["data"]).color)}
      />
      <TagBar state={state} />
      <Controls showInteractive={false}>
        <ControlButton
          title="新建：选中节点时加子节点，否则新建主题"
          onClick={() => {
            const sel = rf.getNodes().filter((n) => n.selected);
            client.createNode(sel.length === 1 ? sel[0].id : null);
          }}
        >
          <span className="ctrl-plus">＋</span>
        </ControlButton>
      </Controls>
    </ReactFlow>
  );
}

function edgeState(focus: { edges: Set<string> } | null, id: string) {
  if (!focus) return "";
  return focus.edges.has(id) ? "hl" : "dim";
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function isDescendant(id: string, ancestorId: string) {
  for (let n = client.state.nodes.get(id); n?.parentId; n = client.state.nodes.get(n.parentId)) {
    if (n.parentId === ancestorId) return true;
  }
  return false;
}
