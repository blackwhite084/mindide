import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, BoardNode, ChatEntry } from "../../server/types.ts";
import { AskForm } from "./AskForm.tsx";
import { client, type ClientState } from "./client.ts";
import { ago } from "./TopbarMenus.tsx";
import { ui } from "./ui.ts";

/** 思考过程：生成中展开显示最后几行，结束后收起 */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = live || open;
  const boxRef = useRef<HTMLDivElement>(null);
  // 生成中贴底滚动：旧内容整行滚出，而不是按字符截断
  useLayoutEffect(() => {
    if (live && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [live, text]);
  return (
    <div className={`thinking-box ${live ? "live" : ""}`}>
      <div className="thinking-head" onClick={() => setOpen(!open)}>
        {live ? "思考中…" : "思考过程"} <span className="muted">{shown ? "▴" : "▾"}</span>
      </div>
      {shown && <div ref={boxRef} className="thinking-text">{text}</div>}
    </div>
  );
}

function ActivityRow({ a, live }: { a: Activity; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (a.ask) {
    return (
      <div className={`act ${a.status}`}>
        <div className="act-row">
          <span className="act-dot" />
          <span className="act-label">{a.label}</span>
        </div>
        <AskForm id={a.id} ask={a.ask} live={live && a.status === "running"} />
      </div>
    );
  }
  return (
    <div className={`act ${a.status} ${a.nodeId ? "linkable" : ""}`}>
      <div
        className="act-row"
        onClick={() => (a.nodeId ? ui.focusNode(a.nodeId) : setOpen(!open))}
        title={a.nodeId ? "在白板上定位" : "查看结果"}
      >
        <span className="act-dot" />
        <span className="act-label">{a.label}</span>
        {!a.nodeId && a.detail && (
          <span className="act-more" onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
            {open ? "收起" : "结果"}
          </span>
        )}
      </div>
      {open && a.detail && <pre className="act-detail">{a.detail}</pre>}
    </div>
  );
}

/**
 * 单条对话。memo：流式输出时只有最后一条在变，其余条目不重新解析 Markdown。
 * 只有用户消息需要 nodes（显示引用的节点标题）。
 */
const Entry = memo(function Entry({ entry, nodes }: { entry: ChatEntry; nodes?: Map<string, BoardNode> }) {
  if (entry.role === "user") {
    return (
      <div className="chat-user">
        {!!entry.contextNodeIds?.length && (
          <div className="chat-refs">
            {entry.contextNodeIds.map((id) => {
              const n = nodes?.get(id);
              return (
                <span key={id} className="chip" onClick={() => n && ui.focusNode(id)}>
                  {n ? n.title || n.summary.slice(0, 12) : "已删除"}
                </span>
              );
            })}
          </div>
        )}
        <div className="chat-bubble">{entry.text}</div>
      </div>
    );
  }
  return (
    <div className="chat-ai">
      {entry.thinking?.trim() && <Thinking text={entry.thinking} live={!!entry.streaming && !entry.text && !entry.activity?.length} />}
      {!!entry.activity?.length && (
        <div className="activity">
          {entry.activity.map((a) => (
            <ActivityRow key={a.id} a={a} live={!!entry.streaming} />
          ))}
        </div>
      )}
      {entry.text.trim() ? (
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
          {entry.streaming && <span className="caret" />}
        </div>
      ) : (
        entry.streaming && !entry.activity?.length && <div className="thinking">思考中…</div>
      )}
    </div>
  );
});

/** 当前对话的标题：第一条用户消息 */
function titleOf(chat: ChatEntry[]) {
  const first = chat.find((e) => e.role === "user")?.text.split("\n").find((l) => l.trim());
  return first?.trim() || "新对话";
}

/** 历史对话列表（放在弹出菜单里，自己订阅状态，删除后即时刷新） */
function HistoryList() {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const list = state.conversations.filter((c) => c.count > 0 || c.id === state.conversation);
  return (
    <div className="conv-list">
      <div className="ctx-title">历史对话</div>
      {list.map((c) => {
        const current = c.id === state.conversation;
        return (
          <div
            key={c.id}
            className={`conv-item ${current ? "on" : ""}`}
            onClick={() => {
              ui.closeMenu();
              if (!current) client.send({ type: "chat:open", id: c.id });
            }}
          >
            <div className="conv-main">
              <div className="conv-title">{current ? titleOf(state.chat) : c.title}</div>
              <div className="ctx-hint">
                {current ? "当前 · " : ""}
                {c.count} 条消息 · {ago(c.updatedAt)}
              </div>
            </div>
            {(!current || state.chat.length > 0) && (
              <button
                className="conv-del"
                title="删除这个对话（白板内容不受影响）"
                onClick={(e) => {
                  e.stopPropagation();
                  client.send({ type: "chat:delete", id: c.id });
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChatHeader({ state }: { state: ClientState }) {
  const others = state.conversations.filter((c) => c.id !== state.conversation && c.count > 0).length;
  return (
    <div className="chat-head">
      <span className="chat-head-title" title={titleOf(state.chat)}>
        {titleOf(state.chat)}
      </span>
      <button
        className="icon-btn"
        title="新对话（白板内容保留，AI 从头开始）"
        disabled={!state.chat.length}
        onClick={() => client.send({ type: "chat:new" })}
      >
        ＋
      </button>
      <button
        className="icon-btn"
        title="历史对话"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          ui.openMenu({ x: r.right - 280, y: r.bottom + 6, items: [], form: <HistoryList /> });
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.8V8l2.2 1.6" />
        </svg>
        {others > 0 && <span className="icon-count">{others}</span>}
      </button>
    </div>
  );
}

export function ChatPanel({ state }: { state: ClientState }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.chat]);

  // 切换对话后回到底部
  useEffect(() => {
    stick.current = true;
  }, [state.conversation]);

  return (
    <>
      <ChatHeader state={state} />
      <div
        ref={box}
        className="chat"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {state.chat.length === 0 && (
          <div className="empty">
            对话记录会出现在这里。
            <br />
            白板上只留下内容本身。
          </div>
        )}
        {state.chat.map((e) => (
          <Entry key={e.id} entry={e} nodes={e.role === "user" ? state.nodes : undefined} />
        ))}
      </div>
    </>
  );
}
