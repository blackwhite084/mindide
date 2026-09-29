import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import type { BoardEdge, BoardNode } from "../../server/types.ts";
import { animator } from "./animator.ts";
import { client, type ClientState } from "./client.ts";
import { layoutTree, type Size } from "./layout.ts";
import { MdNode, type MdFlowNode } from "./MdNode.tsx";
import { diffBoards, fullText } from "./compare.ts";
import { RelationEdge } from "./RelationEdge.tsx";
import { RelationForm } from "./RelationForm.tsx";
import { ui, type MenuItem } from "./ui.ts";

const nodeTypes = { md: MdNode };
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
  const rf = useReactFlow<MdFlowNode>();
  const [rfNodes, setRfNodes] = useState<MdFlowNode[]>([]);
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

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
  const layout = useMemo(() => layoutTree(nodes, sizes, edgeList), [nodes, sizes, edgeList]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  /** 节点不在视野内时平滑移过去；已经可见就不动镜头 */
  const ensureVisible = useCallback(
    async (id: string, force = false) => {
      if (!followRef.current && !force) return;
      // 在折叠的分支里：先展开祖先
      for (let n = client.state.nodes.get(id); n?.parentId; n = client.state.nodes.get(n.parentId)) {
        const p = client.state.nodes.get(n.parentId);
        if (p?.fold) client.patchNode(p.id, { fold: false });
      }
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
      return layout.visible.map((id) => {
        const n = state.nodes.get(id)!;
        const p = prevMap.get(id);
        const depth = layout.depth.get(id) ?? 0;
        const data: MdFlowNode["data"] = {
          node: n,
          depth,
          color: colorOf(layout.branch.get(id) ?? -1),
          childCount: layout.childCount.get(id) ?? 0,
          detail,
          dropTarget: dropTarget === id,
          pending: pendingIds.has(id),
          dim: !!focus && !focus.nodes.has(id),
          related: !!focus && focus.nodes.has(id) && !focus.primary.has(id),
          diff: diff?.nodes.get(id),
          beforeText: diff?.nodes.get(id) === "modified" ? fullText(diff.before.get(id)!) : undefined,
        };
        const position = p?.dragging ? p.position : layout.pos.get(id)!;
        // 内容和位置都没变时复用原对象，让 memo(MdNode) 生效
        if (p && shallowEqual(p.data, data) && p.position.x === position.x && p.position.y === position.y) return p;
        return {
          id,
          type: "md",
          position,
          data,
          selected: p?.selected ?? false,
          dragging: p?.dragging,
          measured: p?.measured,
          className: p ? undefined : "enter",
        };
      });
    });
    // 用 focusKey 而不是 focus 作依赖：只有高亮的节点集合变了才需要重建
  }, [state.nodes, layout, detail, dropTarget, pendingIds, focusKey, diff]);

  const edges: Edge[] = useMemo(() => {
    const tree: Edge[] = [];
    for (const [child, parent] of layout.parent) {
      tree.push({
        id: `t-${child}`,
        source: parent,
        target: child,
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
    const items: MenuItem[] = multi
      ? [
          { title: `已选中 ${selected.length} 个节点` },
          { label: "让 AI 处理这些节点…", hint: "推荐", onClick: () => ui.focusComposer(`想让 AI 怎么处理这 ${selected.length} 个节点？`) },
          { sep: true },
          { label: `删除 ${selected.length} 个节点`, danger: true, onClick: () => selected.forEach((sid) => client.send({ type: "node:delete", id: sid })) },
        ]
      : [
          { title: titleOf(n) },
          { label: "让 AI 改这个节点…", hint: "推荐", onClick: () => ui.askAI(id, titleOf(n)) },
          { sep: true },
          ...(n.md.trim() && detail === "summary"
            ? [{ label: n.open ? "收起正文" : "展开正文", hint: "双击", onClick: () => client.patchNode(id, { open: !n.open }) }]
            : []),
          ...((layout.childCount.get(id) ?? 0) > 0
            ? [{ label: n.fold ? "展开分支" : "折叠分支", onClick: () => client.patchNode(id, { fold: !n.fold }) }]
            : []),
          { label: "手动编辑", onClick: () => ui.requestEdit(id) },
          { label: "添加子节点", hint: "Tab", onClick: () => client.createNode(id) },
          { label: "添加同级节点", hint: "⇧Tab", onClick: () => client.createNode(n.parentId) },
          ...(n.pinned ? [{ label: "恢复自动排版", onClick: () => client.patchNode(id, { pinned: false }) }] : []),
          ...(n.parentId ? [{ label: "变成独立主题", onClick: () => client.patchNode(id, { parentId: null }) }] : []),
          { sep: true },
          { label: "删除", danger: true, hint: "⌫", onClick: () => client.send({ type: "node:delete", id }) },
        ];
    ui.openMenu({ x: e.clientX, y: e.clientY, items });
  };

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
        { label: "全览", onClick: () => rf.fitView({ duration: 400, maxZoom: 1 }) },
      ],
    });
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<MdFlowNode>[]) => {
      setRfNodes((nds) => {
        const next = applyNodeChanges(changes, nds);
        if (changes.some((c) => c.type === "select")) {
          onSelectionChange(next.filter((n) => n.selected).map((n) => n.id));
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
    const hits = rf.getIntersectingNodes(self).filter((n) => n.id !== id && !isDescendant(n.id, id));
    return hits[0]?.id ?? null;
  };

  // 快捷键：选中一个节点时 Tab 新建子节点，⇧Tab 新建同级节点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key !== "Tab") return;
      const sel = rf.getNodes().filter((n) => n.selected);
      if (sel.length !== 1) return;
      e.preventDefault();
      const node = client.state.nodes.get(sel[0].id);
      if (!node) return;
      client.createNode(e.shiftKey ? node.parentId : node.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf]);

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
      onNodeContextMenu={(e, n) => nodeMenu(e, n.id)}
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
      onNodeDrag={(_e, node) => setDropTarget(findDropTarget(node.id))}
      onNodeDragStop={(_e, node) => {
        const target = findDropTarget(node.id);
        setDropTarget(null);
        if (target) client.patchNode(node.id, { parentId: target, pinned: false });
        else client.patchNode(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y), pinned: true });
      }}
      onNodesDelete={(ns) => ns.forEach((n) => client.send({ type: "node:delete", id: n.id }))}
      onEdgesDelete={(es) => es.filter((e) => !e.id.startsWith("t-")).forEach((e) => client.send({ type: "edge:delete", id: e.id }))}
      onConnect={(c) => c.source && c.target && client.send({ type: "edge:add", source: c.source, target: c.target })}
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
        nodeColor={(n) => (n.data as MdFlowNode["data"]).color}
      />
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
