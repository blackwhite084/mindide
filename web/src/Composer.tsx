import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import type { ClientState } from "./client.ts";
import { client } from "./client.ts";
import { ui } from "./ui.ts";

interface Props {
  state: ClientState;
  selected: string[];
  onClearSelection: () => void;
  chatVisible: boolean;
  onOpenChat: () => void;
}

/** 输入框上方的一行状态：AI 正在做什么 */
function StatusLine({ state, chatVisible, onOpenChat }: Pick<Props, "state" | "chatVisible" | "onOpenChat">) {
  const last = [...state.chat].reverse().find((c) => c.role === "ai");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(null), [last?.id]);
  const running = state.busy ? last?.activity?.findLast((a) => a.status === "running") : undefined;
  const tasks = [...state.tasks.values()].filter((t) => t.status === "running").length;

  let status: React.ReactNode = null;
  if (state.busy) {
    status = running ? (
      <span className={running.nodeId ? "linkable" : ""} onClick={() => running.nodeId && ui.focusNode(running.nodeId)}>
        {running.label}
      </span>
    ) : last?.streaming && last.text ? (
      "回复中…"
    ) : (
      "思考中…"
    );
  }
  // 对话面板不可见时，在这里简短展示 AI 的回复
  const peek = !chatVisible && last?.text.trim() && dismissed !== last.id ? last : undefined;
  if (!status && !peek && !tasks) return null;
  return (
    <div className="status-line">
      {peek && (
        <div className="peek" onClick={onOpenChat} title="打开对话">
          <div className="md">
            <ReactMarkdown>{peek.text.length > 280 ? peek.text.slice(-280) : peek.text}</ReactMarkdown>
          </div>
          <button
            className="ghost"
            onClick={(e) => {
              e.stopPropagation();
              setDismissed(peek.id);
            }}
          >
            ×
          </button>
        </div>
      )}
      {(status || tasks > 0) && (
        <div className="status-row">
          {status && (
            <>
              <span className="pulse-dot" />
              {status}
            </>
          )}
          {tasks > 0 && <span className="muted">后台任务 {tasks} 个运行中</span>}
        </div>
      )}
    </div>
  );
}

export function Composer({ state, selected, onClearSelection, chatVisible, onOpenChat }: Props) {
  const [text, setText] = useState("");
  const [hint, setHint] = useState<string | undefined>();
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ui.focusComposer = (placeholder) => {
      setHint(placeholder);
      requestAnimationFrame(() => ta.current?.focus());
    };
  }, []);
  const [pick, setPick] = useState(0);
  // 输入 / 开头且还没输入空格时，列出可用技能
  const slash = /^\/(?:skill:)?([\w-]*)$/.exec(text);
  const matches = slash ? state.skills.filter((s) => s.name.includes(slash[1])) : [];
  const choose = (name: string) => {
    setText(`/skill:${name} `);
    setPick(0);
    ta.current?.focus();
  };
  const { queue, busy } = state;
  const queued = [...queue.steering.map((t) => ({ t, steer: true })), ...queue.followUp.map((t) => ({ t, steer: false }))];

  const send = (mode: "queue" | "steer") => {
    const value = text.trim();
    if (!value) return;
    client.send({ type: "chat", text: value, mode, contextNodeIds: selected, view: client.state.view });
    setText("");
    setHint(undefined);
    onClearSelection();
    ta.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组字（含语音输入法）时的回车不发送
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        choose(matches[Math.min(pick, matches.length - 1)].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(e.metaKey || e.ctrlKey ? "steer" : "queue");
    } else if (e.key === "Escape" && busy) {
      e.preventDefault();
      client.send({ type: "abort" });
    }
  };

  return (
    <div className="composer">
      <StatusLine state={state} chatVisible={chatVisible} onOpenChat={onOpenChat} />
      {queued.length > 0 && (
        <div className="queue">
          <div className="queue-head">
            <span>排队中 {queued.length}</span>
            <button className="ghost" onClick={() => client.send({ type: "queue:clear" })}>
              清空
            </button>
          </div>
          {queued.map((q, i) => (
            <div key={i} className={`queue-item ${q.steer ? "steer" : ""}`}>
              <span className="tag">{q.steer ? "插话" : "稍后"}</span>
              <span className="queue-text">{q.t}</span>
            </div>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="context-chips">
          <span className="muted">关注</span>
          {selected.map((id) => {
            const n = state.nodes.get(id);
            return (
              <span key={id} className="chip">
                {n?.title || n?.summary.slice(0, 16) || id}
              </span>
            );
          })}
          <button className="ghost" onClick={onClearSelection}>
            ×
          </button>
        </div>
      )}
      {matches.length > 0 && (
        <div className="skill-menu">
          {matches.map((s, i) => (
            <div
              key={s.name}
              className={`skill-item ${i === Math.min(pick, matches.length - 1) ? "active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s.name);
              }}
            >
              <span className="skill-name">/skill:{s.name}</span>
              <span className="muted">{s.description}</span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={
            hint ?? (busy ? "AI 正在回答…继续输入会排队（⌘↵ 插话，Esc 打断）" : "想到什么说什么… (↵ 发送，⇧↵ 换行)")
          }
          onBlur={() => !text && setHint(undefined)}
          onChange={(e) => {
            setText(e.target.value);
            setPick(0);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
          }}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <div className="composer-actions">
          {busy && (
            <button className="danger" title="Esc" onClick={() => client.send({ type: "abort" })}>
              打断
            </button>
          )}
          {busy && (
            <button title="⌘↵" onClick={() => send("steer")} disabled={!text.trim()}>
              插话
            </button>
          )}
          <button className="primary" onClick={() => send("queue")} disabled={!text.trim()}>
            {busy ? "排队" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
