import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BoardNode } from "../../server/types.ts";
import { animator, computeSegs, type Frame, type Seg } from "./animator.ts";
import { client, summaryOf } from "./client.ts";
import { fullText } from "./compare.ts";
import { ui } from "./ui.ts";
import { WidgetFrame } from "./WidgetFrame.tsx";
import { tagColor } from "./Tags.tsx";

export type MdFlowNode = Node<
  {
    node: BoardNode;
    depth: number;
    color: string;
    childCount: number;
    detail: "summary" | "full";
    dropTarget: boolean;
    pending: boolean;
    /** 有选中项时，与之无关的节点淡化 */
    dim?: boolean;
    /** 与选中项直接相连的节点 */
    related?: boolean;
    /** 版本对比：相对历史版本新增 / 有改动 */
    diff?: "added" | "modified";
    beforeText?: string;
  },
  "md"
>;

function DiffText({ segs, frame, still }: { segs: Seg[]; frame?: Frame; still?: boolean }) {
  return (
    <div className={`diff-text ${frame?.phase === "fade" ? "fading" : ""}`}>
      {segs.map((s, i) => {
        const active = frame?.activeIndex === i ? { "data-active": true } : {};
        if (s.kind === "eq") return <span key={i}>{s.text}</span>;
        if (s.kind === "del") {
          if (still) return <del key={i} className="seg-del mark">{s.text}</del>;
          if (s.state === "idle") return <span key={i}>{s.text}</span>;
          if (s.state === "done") return null;
          return (
            <del key={i} className={`seg-del ${s.state}`} {...active}>
              {s.text.slice(0, s.shown)}
            </del>
          );
        }
        if (still) return <ins key={i} className="seg-ins">{s.text}</ins>;
        if (s.state === "idle") return null;
        return (
          <ins key={i} className={`seg-ins ${s.state}`} {...active}>
            {s.text.slice(0, s.shown)}
            {s.state === "active" && <span className="caret" />}
          </ins>
        );
      })}
    </div>
  );
}

export function Markdown({ md }: { md: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {md}
      </ReactMarkdown>
    </div>
  );
}

/** 让动画中正在变化的位置保持在可视区域内 */
function useFollowActive(ref: React.RefObject<HTMLDivElement | null>, frame: Frame | undefined) {
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>("[data-active]");
    if (!box || !el) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 40) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" });
    }
  }, [ref, frame?.activeIndex, frame?.segs]);
}

function MdNodeInner({ data, selected }: NodeProps<MdFlowNode>) {
  const { node, depth, color, childCount, detail, dropTarget, pending, dim, related, diff, beforeText } = data;
  const mdFrame = useSyncExternalStore(animator.subscribe, () => animator.frame(node.id, "md"));
  const sumFrame = useSyncExternalStore(animator.subscribe, () => animator.frame(node.id, "summary"));
  const frame = mdFrame ?? sumFrame;
  const waitingMd = useSyncExternalStore(animator.subscribe, () =>
    animator.frame(node.id, "md") ? undefined : animator.pendingBefore(node.id, "md"),
  );
  const waitingSum = useSyncExternalStore(animator.subscribe, () =>
    animator.frame(node.id, "summary") ? undefined : animator.pendingBefore(node.id, "summary"),
  );
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMd, setDraftMd] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const widget = node.kind === "widget";
  useEffect(() => {
    if (!diff) setShowCompare(false);
  }, [diff]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLDivElement>(null);

  const open = node.open || detail === "full";
  useFollowActive(open ? bodyRef : floatRef, mdFrame);

  const startEdit = (focus: "title" | "md" = "md") => {
    if (frame) return;
    setDraftTitle(node.title);
    setDraftMd(node.md);
    setEditing(true);
    // 新建的节点在测量完之前是隐藏的，拿不到焦点：多试几帧
    let tries = 0;
    const tryFocus = () => {
      const el = focus === "title" ? titleRef.current : taRef.current;
      el?.focus();
      if ((!el || document.activeElement !== el) && tries++ < 20) requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
  };

  // 新建的空节点直接进入编辑；右键菜单“手动编辑”也走这里
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;
  useEffect(() => {
    if (client.editRequest === node.id) {
      client.editRequest = undefined;
      startEditRef.current("title");
    }
    return ui.onEditRequest((id) => {
      if (id === node.id) startEditRef.current("md");
    });
  }, [node.id]);

  // 双击：展开/收起正文（编辑在右键菜单里，修改优先交给 AI）
  const toggleOpen = () => {
    if (editing || node.draft) return;
    if (detail === "summary" && node.md.trim()) client.patchNode(node.id, { open: !node.open });
  };

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [draftMd, editing]);

  const commit = () => {
    setEditing(false);
    const patch: { title?: string; md?: string } = {};
    if (draftTitle !== node.title) patch.title = draftTitle;
    if (draftMd !== node.md) patch.md = draftMd;
    if (Object.keys(patch).length) client.send({ type: "node:update", id: node.id, patch });
    else if (!node.title && !node.md) client.send({ type: "node:delete", id: node.id });
  };

  const summary = waitingSum ?? summaryOf(node);
  const hasMore = !!node.md.trim() && (widget || node.md.trim() !== summaryOf(node));
  const summaryView = sumFrame ? (
    <div className="summary">
      <DiffText segs={sumFrame.segs} frame={sumFrame} />
    </div>
  ) : null;

  // 正文区：展开时显示全文（动画直接在正文里播放）；折叠时显示摘要，动画在浮层里播放，不影响整体排版
  let body: React.ReactNode = null;
  if (editing) {
    body = (
      <textarea
        ref={taRef}
        className="editor nodrag nowheel"
        value={draftMd}
        placeholder={widget ? "组件代码（HTML）" : "正文（Markdown）"}
        onChange={(e) => setDraftMd(e.target.value)}
      />
    );
  } else if (widget && open && !mdFrame && node.md.trim()) {
    body = (
      <>
        {summaryView ?? (node.summary && <div className="summary">{node.summary}</div>)}
        <WidgetFrame node={node} active={!!selected} runKey={runKey} />
      </>
    );
  } else if (open && (mdFrame || waitingMd !== undefined || node.md.trim())) {
    body = (
      <>
        {summaryView}
        {mdFrame ? (
          <DiffText segs={mdFrame.segs} frame={mdFrame} />
        ) : (
          <Markdown md={waitingMd ?? node.md} />
        )}
      </>
    );
  } else if (summaryView) {
    body = summaryView;
  } else if (node.draft) {
    body = (
      <div className="summary">
        {summary}
        <span className="caret" />
        {node.md && <div className="draft-meta">{widget ? "代码" : "正文"} {node.md.length} 字</div>}
      </div>
    );
  } else if (summary) {
    body = <div className="summary">{summary}</div>;
  } else if (!node.title) {
    body = <div className="placeholder">右键 → 手动编辑，或让 AI 来写</div>;
  }

  const floating =
    !editing && !open && mdFrame ? (
      <div ref={floatRef} className="float-panel nowheel">
        <div className="float-by">{mdFrame.by} 正在修改正文…</div>
        <DiffText segs={mdFrame.segs} frame={mdFrame} />
      </div>
    ) : !editing && showCompare && beforeText !== undefined ? (
      <div className="float-panel compare nowheel nodrag">
        <div className="float-by">与对比版本相比的变化</div>
        <DiffText segs={computeSegs(beforeText, fullText(node))} still />
      </div>
    ) : !editing && showDiff && node.lastEdit ? (
      <div className="float-panel nowheel nodrag">
        <div className="float-by">
          {node.lastEdit.by} · {new Date(node.lastEdit.at).toLocaleTimeString()}
          <span className="spacer" />
          <button
            onClick={() => {
              setShowDiff(false);
              client.send({ type: "node:revert", id: node.id });
            }}
          >
            撤销这次修改
          </button>
        </div>
        <DiffText segs={computeSegs(node.lastEdit.before, node.lastEdit.after)} still />
      </div>
    ) : null;

  return (
    <div
      className={[
        "mdnode",
        `d-${Math.min(depth, 2)}`,
        `k-${node.kind}`,
        selected && "selected",
        frame && frame.mode === "edit" && "animating",
        frame && `phase-${frame.phase}`,
        open && "open",
        dropTarget && "drop-target",
        node.draft && "draft",
        dim && !frame && "dim",
        diff && `diff-${diff}`,
        related && "related",
        pending && !frame && "pending",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--c": color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} />
      {editing ? (
        <div
          ref={editRef}
          className="edit-box nodrag"
          onBlur={(e) => {
            if (!editRef.current?.contains(e.relatedTarget as globalThis.Node | null)) commit();
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
              e.preventDefault();
              commit();
            } else if (e.key === "Enter" && e.target === titleRef.current) {
              e.preventDefault();
              taRef.current?.focus();
            }
          }}
        >
          <input
            ref={titleRef}
            className="title-input"
            value={draftTitle}
            placeholder="标题"
            onChange={(e) => setDraftTitle(e.target.value)}
          />
          {body}
        </div>
      ) : (
        <>
          <div className="mdnode-head" onDoubleClick={toggleOpen}>
            {node.kind === "task" && <span className="kind">报告</span>}
            {widget && <span className="kind widget">组件</span>}
            {node.draft && <span className="kind drafting">AI 正在写</span>}
            {pending && !frame && !node.draft && <span className="kind drafting">AI 准备修改</span>}
            <span className="title">{node.title || summary.slice(0, 16) || "未命名"}</span>
            {node.pinned && (
              <button
                className="icon nodrag"
                title="已固定位置，点击恢复自动排版"
                onClick={() => client.patchNode(node.id, { pinned: false })}
              >
                ⌖
              </button>
            )}
            {diff === "added" && <span className="kind diff-tag added">新增</span>}
            {diff === "modified" && (
              <button
                className={`kind diff-tag modified nodrag ${showCompare ? "on" : ""}`}
                title="查看相对对比版本的变化"
                onClick={() => setShowCompare(!showCompare)}
              >
                有改动
              </button>
            )}
            {!frame && !diff && node.lastEdit && (
              <button
                className={`badge nodrag ${showDiff ? "on" : ""}`}
                title="查看最近一次修改"
                onClick={() => setShowDiff(!showDiff)}
              >
                已改
              </button>
            )}
            {widget && open && !node.draft && (
              <button className="icon nodrag" title="重新运行" onClick={() => setRunKey((k) => k + 1)}>
                ↻
              </button>
            )}
            {hasMore && detail === "summary" && (
              <button
                className="icon nodrag"
                title={widget ? (node.open ? "收起组件" : "运行组件") : node.open ? "收起正文" : "展开正文"}
                onClick={() => client.patchNode(node.id, { open: !node.open })}
              >
                {node.open ? "▴" : "▾"}
              </button>
            )}
          </div>
          <div
            ref={bodyRef}
            className={`mdnode-body ${open && !widget ? "nowheel" : ""}`}
            onDoubleClick={toggleOpen}
          >
            {body}
          </div>
        </>
      )}
      {!editing && !!node.tags?.length && (
        <div className="tag-chips nodrag">
          {node.tags.map((t) => (
            <button
              key={t}
              className={`tag-chip ${client.state.tagFilter === t ? "on" : ""}`}
              style={{ "--tc": tagColor(t) } as React.CSSProperties}
              title="按这个标签筛选"
              onClick={() => client.setTagFilter(client.state.tagFilter === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {floating}
      {childCount > 0 && (
        <button
          className="fold-btn nodrag"
          title={node.fold ? "展开分支" : "折叠分支"}
          onClick={() => client.patchNode(node.id, { fold: !node.fold })}
        >
          {node.fold ? childCount : "−"}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const MdNode = memo(MdNodeInner);
