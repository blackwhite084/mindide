import { useMemo, useState } from "react";
import type { BoardNode } from "../../server/types.ts";
import type { ClientState } from "./client.ts";
import { TaskCard } from "./TaskPanel.tsx";
import { ui } from "./ui.ts";

interface Item {
  node: BoardNode;
  children: Item[];
}

function buildTree(nodes: Map<string, BoardNode>): Item[] {
  const items = new Map<string, Item>();
  for (const n of nodes.values()) if (!n.draft) items.set(n.id, { node: n, children: [] });
  const roots: Item[] = [];
  for (const it of items.values()) {
    const parent = it.node.parentId ? items.get(it.node.parentId) : undefined;
    (parent ? parent.children : roots).push(it);
  }
  const byTime = (a: Item, b: Item) => a.node.createdAt - b.node.createdAt;
  roots.sort(byTime);
  for (const it of items.values()) it.children.sort(byTime);
  return roots;
}

function Row({ item, depth, collapsed, toggle }: { item: Item; depth: number; collapsed: Set<string>; toggle: (id: string) => void }) {
  const { node, children } = item;
  const isOpen = !collapsed.has(node.id);
  return (
    <>
      <div className="ol-row" style={{ paddingLeft: 8 + depth * 16 }} onClick={() => ui.focusNode(node.id)}>
        <span
          className={`ol-arrow ${children.length ? "" : "leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (children.length) toggle(node.id);
          }}
        >
          {children.length ? (isOpen ? "▾" : "▸") : "•"}
        </span>
        <span className="ol-title">{node.title || "未命名"}</span>
      </div>
      {isOpen && children.map((c) => <Row key={c.node.id} item={c} depth={depth + 1} collapsed={collapsed} toggle={toggle} />)}
    </>
  );
}

/** 类似 Markdown 大纲：按思维树层级列出所有卡片标题，默认展开第一层 */
export function OutlinePanel({ state }: { state: ClientState }) {
  const roots = useMemo(() => buildTree(state.nodes), [state.nodes]);
  // 记录用户手动改过的节点；其余按默认规则（根展开，更深层折叠）
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const collapsed = useMemo(() => {
    const set = new Set<string>();
    const walk = (items: Item[], depth: number) => {
      for (const it of items) {
        if (!it.children.length) continue;
        const open = overrides.get(it.node.id) ?? depth === 0;
        if (!open) set.add(it.node.id);
        walk(it.children, depth + 1);
      }
    };
    walk(roots, 0);
    return set;
  }, [roots, overrides]);
  const toggle = (id: string) =>
    setOverrides((prev) => new Map(prev).set(id, collapsed.has(id)));

  const running = [...state.tasks.values()].filter((t) => t.status === "running");

  return (
    <div className="outline">
      {running.length > 0 && (
        <div className="outline-tasks">
          {running.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </div>
      )}
      <div className="outline-list">
        {roots.length === 0 && <div className="empty">白板还是空的</div>}
        {roots.map((r) => (
          <Row key={r.node.id} item={r} depth={0} collapsed={collapsed} toggle={toggle} />
        ))}
      </div>
    </div>
  );
}
