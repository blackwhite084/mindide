import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import { animator } from "./animator.ts";
import { client, type ClientState } from "./client.ts";
import { layoutTree, type Size } from "./layout.ts";
import { MdNode, type MdFlowNode } from "./MdNode.tsx";
import { ui } from "./ui.ts";

const nodeTypes = { md: MdNode };
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
  // AI 正在准备修改的节点（工具参数还在生成中）
  const pendingIds = useMemo(() => {
    const ids = new Set<string>();
    const last = state.chat.at(-1);
    if (state.busy && last?.role === "ai") {
      for (const a of last.activity ?? []) {
        if (a.status === "running" && a.nodeId && a.tool !== "canvas_read") ids.add(a.nodeId);
      }
    }
    for (const t of state.tasks.values()) {
      if (t.status !== "running") continue;
      for (const a of t.activity) if (a.status === "running" && a.nodeId && a.tool !== "canvas_read") ids.add(a.nodeId);
    }
    return ids;
  }, [state.chat, state.busy, state.tasks]);
  const layout = useMemo(() => layoutTree(nodes, sizes), [nodes, sizes]);
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

  // 状态 + 布局 → React Flow 节点，保留选中、测量、拖动中的状态
  useEffect(() => {
    setRfNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]));
      return layout.visible.map((id) => {
        const n = state.nodes.get(id)!;
        const p = prevMap.get(id);
        const depth = layout.depth.get(id) ?? 0;
        return {
          id,
          type: "md",
          position: p?.dragging ? p.position : layout.pos.get(id)!,
          data: {
            node: n,
            depth,
            color: colorOf(layout.branch.get(id) ?? -1),
            childCount: layout.childCount.get(id) ?? 0,
            detail,
            dropTarget: dropTarget === id,
            pending: pendingIds.has(id),
          },
          selected: p?.selected ?? false,
          dragging: p?.dragging,
          measured: p?.measured,
          className: p ? undefined : "enter",
        };
      });
    });
  }, [state.nodes, layout, detail, dropTarget, pendingIds]);

  const edges: Edge[] = useMemo(() => {
    const tree: Edge[] = [];
    for (const [child, parent] of layout.parent) {
      tree.push({
        id: `t-${child}`,
        source: parent,
        target: child,
        className: "tree-edge",
        style: { stroke: colorOf(layout.branch.get(child) ?? -1) },
        selectable: false,
        focusable: false,
      });
    }
    const shown = new Set(layout.visible);
    const links = [...state.edges.values()]
      .filter((e) => shown.has(e.source) && shown.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target, className: "link-edge" }));
    return [...tree, ...links];
  }, [layout, state.edges]);

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
      onNodesChange={onNodesChange}
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
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        client.createNode(null, { x: Math.round(p.x), y: Math.round(p.y) });
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
        nodeColor={(n) => (n.data as MdFlowNode["data"]).color}
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function isDescendant(id: string, ancestorId: string) {
  for (let n = client.state.nodes.get(id); n?.parentId; n = client.state.nodes.get(n.parentId)) {
    if (n.parentId === ancestorId) return true;
  }
  return false;
}
