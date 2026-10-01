import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task } from "../../server/types.ts";
import { client, type ClientState } from "./client.ts";
import { AskForm } from "./AskForm.tsx";
import { ui } from "./ui.ts";

const STATUS: Record<Task["status"], string> = {
  running: "进行中",
  done: "完成",
  error: "出错",
  aborted: "已停止",
};

function TaskCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(task.status === "running");
  const [msg, setMsg] = useState("");
  return (
    <div className={`task ${task.status}`}>
      <div className="task-head" onClick={() => setOpen(!open)}>
        <span className="task-dot" />
        <span className="task-title">{task.title}</span>
        <span className="task-status">{STATUS[task.status]}</span>
      </div>
      {open && (
        <div className="task-body">
          {task.activity.length > 0 && (
            <div className="activity">
              {task.activity.map((a) => (
                <div key={a.id} className={`act ${a.status} ${a.nodeId ? "linkable" : ""}`}>
                  <div className="act-row" onClick={() => a.nodeId && ui.focusNode(a.nodeId)}>
                    <span className="act-dot" />
                    <span className="act-label">{a.label}</span>
                  </div>
                  {a.ask && <AskForm id={a.id} ask={a.ask} live={task.status === "running" && a.status === "running"} />}
                </div>
              ))}
            </div>
          )}
          {task.log.trim() && (
            <div className="task-log md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.log}</ReactMarkdown>
            </div>
          )}
          <div className="task-actions">
            {task.resultNodeId && (
              <button onClick={() => ui.focusNode(task.resultNodeId!)}>定位报告</button>
            )}
            {task.status === "running" && (
              <button className="danger" onClick={() => client.send({ type: "task:abort", id: task.id })}>
                停止
              </button>
            )}
          </div>
          <input
            className="task-input"
            placeholder="给这个 agent 补充指示…"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && msg.trim()) {
                client.send({ type: "task:steer", id: task.id, text: msg.trim() });
                setMsg("");
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

export function TaskPanel({ state, selected }: { state: ClientState; selected: string[] }) {
  const [text, setText] = useState("");
  const tasks = [...state.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);

  const create = () => {
    if (!text.trim()) return;
    client.send({ type: "task:create", instructions: text.trim(), contextNodeIds: selected });
    setText("");
  };

  return (
    <>
      <div className="task-new">
        <textarea
          rows={3}
          value={text}
          placeholder="交给后台 agent 做什么？比如：调研竞品定价、把关于定价的讨论归纳成一个节点"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create();
          }}
        />
        <div className="task-new-foot">
          <span className="muted">{selected.length ? `附带 ${selected.length} 个选中节点` : "可先在白板上选中节点作为上下文"}</span>
          <button className="primary" onClick={create} disabled={!text.trim()}>
            派发
          </button>
        </div>
      </div>
      <div className="task-list">
        {tasks.length === 0 && <div className="empty">还没有任务。也可以直接在对话里让 AI「派个 agent 去…」</div>}
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </div>
    </>
  );
}
