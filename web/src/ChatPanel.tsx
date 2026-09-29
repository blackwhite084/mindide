import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, BoardNode, ChatEntry } from "../../server/types.ts";
import type { ClientState } from "./client.ts";
import { ui } from "./ui.ts";

/** 思考过程：生成中展开显示最后几行，结束后收起 */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = live || open;
  return (
    <div className={`thinking-box ${live ? "live" : ""}`}>
      <div className="thinking-head" onClick={() => setOpen(!open)}>
        {live ? "思考中…" : "思考过程"} <span className="muted">{shown ? "▴" : "▾"}</span>
      </div>
      {shown && <div className="thinking-text">{live ? text.slice(-400) : text}</div>}
    </div>
  );
}

function ActivityRow({ a }: { a: Activity }) {
  const [open, setOpen] = useState(false);
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
            <ActivityRow key={a.id} a={a} />
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

export function ChatPanel({ state }: { state: ClientState }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.chat]);

  return (
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
  );
}
