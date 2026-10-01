import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { CardDetail } from "./CardDetail.tsx";
import { Canvas } from "./Canvas.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { client } from "./client.ts";
import { Composer } from "./Composer.tsx";
import { CompareBanner } from "./CompareBanner.tsx";
import { ContextMenu } from "./ContextMenu.tsx";
import { FileMenu } from "./FileMenu.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { SourcesPanel } from "./SourcesPanel.tsx";
import { BoardSwitcher, ModelMenu, NewBoardButton } from "./TopbarMenus.tsx";
import { OutlinePanel } from "./OutlinePanel.tsx";
import { VersionPanel } from "./VersionPanel.tsx";

function Shell() {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [selected, setSelected] = useState<string[]>([]);
  const [follow, setFollow] = useState(() => localStorage.getItem("follow") !== "0");
  const [panel, setPanel] = useState(true);
  const [tab, setTab] = useState<"chat" | "outline" | "sources" | "versions">("chat");
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

  // ⌘Z 撤销，⇧⌘Z / ⌘Y 重做（输入框里交给浏览器自己处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const key = e.key.toLowerCase();
      if (key === "z" || key === "y") {
        e.preventDefault();
        client.send({ type: key === "z" && !e.shiftKey ? "undo" : "redo" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 切换白板：清掉选中，镜头看全局
  useEffect(() => {
    if (!state.board) return;
    setSelected([]);
    const t = setTimeout(() => rf.fitView({ duration: 300, maxZoom: 1 }), 250);
    return () => clearTimeout(t);
  }, [state.board, rf]);

  return (
    <div className={`app ${panel ? "with-panel" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className={`status-dot ${state.connected ? (state.busy ? "busy" : "ok") : "off"}`} />
          AI Minder
          <span className="brand-sep">/</span>
          <BoardSwitcher state={state} />
          <NewBoardButton />
        </div>
        <div className="topbar-actions">
          <div className="seg-toggle small">
            <button title="撤销 ⌘Z" disabled={!state.history.undo} onClick={() => client.send({ type: "undo" })}>
              ↶ 撤销
            </button>
            <button title="重做 ⇧⌘Z" disabled={!state.history.redo} onClick={() => client.send({ type: "redo" })}>
              ↷ 重做
            </button>
          </div>
          <ModelMenu state={state} />
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
          <button className="ghost" title="搜索节点" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}>
            搜索 <span className="kbd">⌘K</span>
          </button>
          <FileMenu selected={selected} />
          <button className="ghost" onClick={() => setPanel(!panel)}>
            {panel ? "隐藏侧栏" : "侧栏"}
          </button>
        </div>
      </header>
      <main className="stage">
        <Canvas state={state} follow={follow} detail={detail} onSelectionChange={onSelectionChange} />
        <CompareBanner state={state} />
        {state.nodes.size === 0 && (
          <div className="empty-board">
            <div className="empty-title">空白板</div>
            <div className="muted">在下方直接说出你的想法，AI 会把内容整理成节点</div>
            <button className="primary" onClick={() => client.createNode(null)}>
              ＋ 手动新建主题
            </button>
            <div className="empty-tips">
              双击空白处新建主题 · 选中节点按 Tab 加子节点 · 双击节点展开/收起 · 按 Space 弹窗看详情 · 右键更多操作
            </div>
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
      <SearchPalette state={state} />
      <CardDetail state={state} />
      {panel && (
        <aside className="panel">
          <div className="panel-tabs">
            <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
              对话
            </button>
            <button className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}>
              大纲{running > 0 && <span className="pill">{running}</span>}
            </button>
            <button className={tab === "sources" ? "on" : ""} onClick={() => setTab("sources")}>
              资料{state.sources.length > 0 && <span className="count">{state.sources.length}</span>}
            </button>
            <button className={tab === "versions" ? "on" : ""} onClick={() => setTab("versions")}>
              版本树<span className="count">{state.versions.length}</span>
            </button>
          </div>
          {tab === "chat" && <ChatPanel state={state} />}
          {tab === "outline" && <OutlinePanel state={state} />}
          {tab === "sources" && <SourcesPanel state={state} />}
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
