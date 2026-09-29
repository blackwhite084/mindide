import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { Canvas } from "./Canvas.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { client } from "./client.ts";
import { Composer } from "./Composer.tsx";
import { ContextMenu } from "./ContextMenu.tsx";
import { FileMenu } from "./FileMenu.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { VersionPanel } from "./VersionPanel.tsx";

function Shell() {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [selected, setSelected] = useState<string[]>([]);
  const [follow, setFollow] = useState(() => localStorage.getItem("follow") !== "0");
  const [panel, setPanel] = useState(true);
  const [tab, setTab] = useState<"chat" | "tasks" | "versions">("chat");
  const [detail, setDetail] = useState<"summary" | "full">(() =>
    localStorage.getItem("detail") === "full" ? "full" : "summary",
  );
  const running = [...state.tasks.values()].filter((t) => t.status === "running").length;
  const rf = useReactFlow();

  useEffect(() => {
    localStorage.setItem("follow", follow ? "1" : "0");
    localStorage.setItem("detail", detail);
  }, [follow, detail]);

  const onSelectionChange = useCallback((ids: string[]) => {
    setSelected((prev) => (prev.join() === ids.join() ? prev : ids));
  }, []);

  const clearSelection = useCallback(() => {
    rf.setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setSelected([]);
  }, [rf]);

  return (
    <div className={`app ${panel ? "with-panel" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className={`status-dot ${state.connected ? (state.busy ? "busy" : "ok") : "off"}`} />
          AI Minder
        </div>
        <div className="topbar-actions">
          <div className="seg-toggle small" title="节点默认显示摘要还是全文">
            <button className={detail === "summary" ? "on" : ""} onClick={() => setDetail("summary")}>
              摘要
            </button>
            <button className={detail === "full" ? "on" : ""} onClick={() => setDetail("full")}>
              全文
            </button>
          </div>
          <label className="toggle" title="AI 修改节点时镜头自动跟过去">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            跟随 AI
          </label>
          <button className="ghost" onClick={() => rf.fitView({ duration: 400, maxZoom: 1 })}>
            全览
          </button>
          <FileMenu selected={selected} />
          <button className="ghost" onClick={() => setPanel(!panel)}>
            {panel ? "隐藏侧栏" : "侧栏"}
          </button>
        </div>
      </header>
      <main className="stage">
        <Canvas state={state} follow={follow} detail={detail} onSelectionChange={onSelectionChange} />
        {state.nodes.size === 0 && (
          <div className="hint">
            在下方输入想法开始 · 双击节点展开 · 右键更多操作 · 拖到别的节点上可调整层级
          </div>
        )}
        <Composer
          state={state}
          selected={selected}
          onClearSelection={clearSelection}
          chatVisible={panel && tab === "chat"}
          onOpenChat={() => {
            setPanel(true);
            setTab("chat");
          }}
        />
        <div className="toasts">
          {state.errors.map((e) => (
            <div key={e.id} className="toast">
              {e.message}
            </div>
          ))}
        </div>
      </main>
      <ContextMenu />
      {panel && (
        <aside className="panel">
          <div className="panel-tabs">
            <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
              对话
            </button>
            <button className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>
              调度板{running > 0 && <span className="pill">{running}</span>}
            </button>
            <button className={tab === "versions" ? "on" : ""} onClick={() => setTab("versions")}>
              版本树<span className="count">{state.versions.length}</span>
            </button>
          </div>
          {tab === "chat" && <ChatPanel state={state} />}
          {tab === "tasks" && <TaskPanel state={state} selected={selected} />}
          {tab === "versions" && <VersionPanel state={state} />}
        </aside>
      )}
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
