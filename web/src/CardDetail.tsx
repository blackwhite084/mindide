import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BoardNode } from "../../server/types.ts";
import { summaryOf, type ClientState } from "./client.ts";
import { Markdown } from "./MdNode.tsx";
import { ui } from "./ui.ts";
import { WidgetFrame } from "./WidgetFrame.tsx";

const titleOf = (n: BoardNode) => n.title || summaryOf(n).slice(0, 16) || "未命名";

/** Space 打开的卡片详情弹窗：大窗口看全文；←→ 切换同级，↑ 父节点，↓ 子节点，Esc / Space 关闭 */
export function CardDetail({ state }: { state: ClientState }) {
  const id = useSyncExternalStore(ui.subscribeDetail, ui.getDetail);
  const node = id ? state.nodes.get(id) : undefined;
  const [runKey, setRunKey] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 节点被删了就关掉
  useEffect(() => {
    if (id && !node) ui.openDetail(null);
  }, [id, node]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [id]);

  const siblings = node
    ? [...state.nodes.values()].filter((n) => n.parentId === node.parentId && !n.draft).sort((a, b) => a.createdAt - b.createdAt)
    : [];
  const children = node ? [...state.nodes.values()].filter((n) => n.parentId === node.id && !n.draft).sort((a, b) => a.createdAt - b.createdAt) : [];
  const idx = node ? siblings.findIndex((n) => n.id === node.id) : -1;
  const prev = idx > 0 ? siblings[idx - 1] : undefined;
  const next = idx >= 0 ? siblings[idx + 1] : undefined;
  const parent = node?.parentId ? state.nodes.get(node.parentId) : undefined;

  const navRef = useRef({ prev, next, parent, child: children[0] });
  navRef.current = { prev, next, parent, child: children[0] };

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const nav = navRef.current;
      const go = (n?: BoardNode) => n && ui.openDetail(n.id);
      if (e.key === "Escape" || e.key === " ") ui.openDetail(null);
      else if (e.key === "ArrowLeft") go(nav.prev);
      else if (e.key === "ArrowRight") go(nav.next);
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // 正文还能滚就先滚，滚到头再跳到父 / 子节点
        const dir = e.key === "ArrowUp" ? -1 : 1;
        const body = bodyRef.current;
        if (body && canScroll(body, dir)) body.scrollBy({ top: dir * 80 });
        else go(dir < 0 ? nav.parent : nav.child);
      } else if (e.key === "Tab" || e.key === "Backspace" || e.key === "Delete") {
        // 弹窗打开时别让画布的 Tab 新建节点、退格删节点
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id]);

  if (!node) return null;
  const widget = node.kind === "widget";
  const path: BoardNode[] = [];
  for (let p = parent; p; p = p.parentId ? state.nodes.get(p.parentId) : undefined) path.unshift(p);

  const close = () => ui.openDetail(null);
  const locate = (target: BoardNode) => {
    close();
    ui.focusNode(target.id);
  };

  return (
    <div className="detail-backdrop" onPointerDown={close}>
      <div className={`detail ${widget ? "k-widget" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
        <div className="detail-head">
          {path.length > 0 && (
            <div className="detail-path">
              {path.map((p) => (
                <button key={p.id} onClick={() => ui.openDetail(p.id)}>
                  {titleOf(p)}
                </button>
              ))}
            </div>
          )}
          <div className="detail-title-row">
            {node.kind === "task" && <span className="kind">报告</span>}
            {widget && <span className="kind widget">组件</span>}
            <h2 className="detail-title">{titleOf(node)}</h2>
            {widget && (
              <button className="ghost" title="重新运行" onClick={() => setRunKey((k) => k + 1)}>
                ↻
              </button>
            )}
            <button className="ghost" title="在画布上定位" onClick={() => locate(node)}>
              定位
            </button>
            <button
              className="ghost"
              onClick={() => {
                close();
                ui.askAI(node.id, titleOf(node));
              }}
            >
              让 AI 改
            </button>
            <button
              className="ghost"
              onClick={() => {
                locate(node);
                ui.requestEdit(node.id);
              }}
            >
              {widget ? "编辑代码" : "编辑"}
            </button>
            <button className="ghost" title="关闭 Esc" onClick={close}>
              ✕
            </button>
          </div>
          {node.summary && node.summary.trim() !== node.md.trim() && <div className="detail-summary">{node.summary}</div>}
        </div>
        <div ref={bodyRef} className="detail-body">
          {widget && node.md.trim() ? (
            <WidgetFrame node={node} active runKey={runKey} />
          ) : node.md.trim() ? (
            <Markdown md={node.md} />
          ) : (
            <div className="muted">{summaryOf(node) || "这张卡片还没有正文"}</div>
          )}
          {children.length > 0 && (
            <div className="detail-children">
              <div className="detail-label">子节点</div>
              {children.map((c) => (
                <button key={c.id} className="detail-child" onClick={() => ui.openDetail(c.id)}>
                  <span className="detail-child-title">{titleOf(c)}</span>
                  <span className="detail-child-sub">{summaryOf(c)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="detail-foot">
          <button className="ghost" disabled={!prev} onClick={() => prev && ui.openDetail(prev.id)}>
            ← {prev ? titleOf(prev) : "上一个"}
          </button>
          <span className="muted">
            {siblings.length > 1 ? `${idx + 1} / ${siblings.length} · ` : ""}←→ 同级 · ↑↓ 父/子 · Esc 关闭
          </span>
          <button className="ghost" disabled={!next} onClick={() => next && ui.openDetail(next.id)}>
            {next ? titleOf(next) : "下一个"} →
          </button>
        </div>
      </div>
    </div>
  );
}

/** 正文还能朝这个方向滚动时，方向键优先用来滚动 */
function canScroll(el: HTMLElement | null, dir: 1 | -1) {
  if (!el) return false;
  return dir < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}
