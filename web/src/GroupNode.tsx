import { memo, useEffect, useRef, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { BoardGroup } from "../../server/types.ts";
import { client } from "./client.ts";
import { groupKey } from "./layout.ts";
import { ui } from "./ui.ts";

export type GroupFlowNode = Node<
  {
    group: BoardGroup;
    color: string;
    /** 组内主题的标题（按排列顺序） */
    topics: string[];
    cards: number;
    /** 正在把卡片拖进这个分组 */
    dropTarget: boolean;
  },
  "group"
>;

function GroupNodeInner({ data }: NodeProps<GroupFlowNode>) {
  const { group, color, topics, cards, dropTarget } = data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setDraft(group.title);
    setEditing(true);
  };

  // 新建的节点在测量完之前是隐藏的，拿不到焦点：多试几帧
  useEffect(() => {
    if (!editing) return;
    let tries = 0;
    let raf = 0;
    const tryFocus = () => {
      const el = inputRef.current;
      el?.focus();
      if (el && document.activeElement === el) el.select();
      else if (tries++ < 20) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [editing]);
  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;

  // 新建的分组直接进入改名；右键菜单“重命名”也走这里
  useEffect(() => {
    const key = groupKey(group.id);
    if (client.editRequest === key) {
      client.editRequest = undefined;
      startEditRef.current();
    }
    return ui.onEditRequest((id) => {
      if (id === key) startEditRef.current();
    });
  }, [group.id]);

  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== group.title) client.send({ type: "group:update", id: group.id, patch: { title } });
  };
  const toggleFold = () => client.patchGroup(group.id, { fold: !group.fold });

  return (
    <div
      className={["groupnode", group.fold && "folded", dropTarget && "drop-target"].filter(Boolean).join(" ")}
      style={{ "--c": color } as React.CSSProperties}
    >
      <div className="group-head">
        <button className="icon nodrag" title={group.fold ? "展开分组" : "折叠分组"} onClick={toggleFold}>
          {group.fold ? "▸" : "▾"}
        </button>
        {editing ? (
          <input
            ref={inputRef}
            className="group-title-input nodrag"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="group-title" title="双击改名" onDoubleClick={startEdit}>
            {group.title || "未命名分组"}
          </span>
        )}
        <span className="group-count">
          {topics.length} 个主题 · {cards} 张卡片
        </span>
      </div>
      {group.fold ? (
        <div className="group-preview" onDoubleClick={toggleFold} title="双击展开">
          {topics.length ? (
            <>
              {topics.slice(0, 3).map((t, i) => (
                <div key={i} className="group-topic">
                  {t}
                </div>
              ))}
              {topics.length > 3 && <div className="group-more">还有 {topics.length - 3} 个主题</div>}
            </>
          ) : (
            <div className="group-more">空分组</div>
          )}
        </div>
      ) : (
        <div className="group-body">{!topics.length && <div className="group-empty">把卡片拖进来，或双击这里新建主题</div>}</div>
      )}
    </div>
  );
}

export const GroupNode = memo(GroupNodeInner);
