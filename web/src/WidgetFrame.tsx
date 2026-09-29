import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BoardNode } from "../../server/types.ts";
import { codeHash } from "../../server/widget.ts";
import { client } from "./client.ts";

/**
 * 组件节点的运行环境：sandbox 只给 allow-scripts（没有 allow-same-origin），代码碰不到主页面、cookie 和 WebSocket；
 * 内层 CSP 禁止一切网络请求，外层 index.html 的 frame-src 'none' 禁止 iframe 跳转到别的地址，
 * 这样即使代码拿到了白板数据也带不出去。与外面的通信只有 postMessage。
 */
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const BOOTSTRAP = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
:root { color-scheme: dark; }
html, body { margin: 0; background: transparent; color: #e6e8eb; font: 13px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
body { padding: 2px; overflow-x: hidden; }
</style>
<script>
(() => {
  const post = (m) => parent.postMessage(Object.assign({ __minder: 1 }, m), "*");
  const report = (e) => post({ type: "error", message: String((e && (e.stack || e.message)) || e).slice(0, 2000) });
  let data = null;
  const cbs = [];
  window.minder = {
    get data() { return data; },
    onData(cb) { cbs.push(cb); if (data) try { cb(data); } catch (e) { report(e); } },
    node: (id) => data && data.nodes.find((n) => n.id === id),
    children: (id) => (data ? data.nodes.filter((n) => n.parentId === (id === undefined ? data.self.id : id)) : []),
  };
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || !e.data.__minder || e.data.type !== "data") return;
    data = e.data.data;
    for (const cb of cbs) try { cb(data); } catch (err) { report(err); }
  });
  addEventListener("error", (e) => report(e.error || e.message));
  addEventListener("unhandledrejection", (e) => report(e.reason));
  let last = 0;
  const size = () => {
    const h = Math.ceil(document.body ? document.body.getBoundingClientRect().bottom + scrollY : 0);
    if (h !== last) { last = h; post({ type: "resize", h }); }
  };
  addEventListener("DOMContentLoaded", () => new ResizeObserver(size).observe(document.body));
  addEventListener("load", () => { size(); post({ type: "ready" }); });
})();
</script>`;

function buildDoc(code: string) {
  // 写了完整文档就插进它的 <head>，否则包一层；注入的内容必须排在用户代码前面
  if (/<head[\s>]/i.test(code)) {
    const doc = code.replace(/<head[^>]*>/i, (m) => m + BOOTSTRAP);
    return /^\s*<!doctype/i.test(doc) ? doc : `<!doctype html>${doc}`;
  }
  return `<!doctype html><html><head>${BOOTSTRAP}</head><body>${code}</body></html>`;
}

const MIN_H = 40;
const MAX_H = 900;

/** 给组件看的白板数据（只读）；组件自己的代码不给 */
function useBoardData(self: BoardNode) {
  const nodes = useSyncExternalStore(client.subscribe, () => client.state.nodes);
  const edges = useSyncExternalStore(client.subscribe, () => client.state.edges);
  return useMemo(
    () => ({
      self: { id: self.id, title: self.title, summary: self.summary, parentId: self.parentId },
      nodes: [...nodes.values()]
        .filter((n) => !n.draft)
        .map(({ id, title, summary, md, parentId, kind }) => ({ id, title, summary, md: kind === "widget" ? "" : md, parentId, kind })),
      edges: [...edges.values()].map(({ source, target, dir, label, reverseLabel }) => ({ source, target, dir, label, reverseLabel })),
    }),
    [nodes, edges, self.id, self.title, self.summary, self.parentId],
  );
}

export function WidgetFrame({ node, active, runKey }: { node: BoardNode; active: boolean; runKey: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const code = node.md;
  const hash = useMemo(() => codeHash(code), [code]);
  const doc = useMemo(() => buildDoc(code), [code]);
  const data = useBoardData(node);
  const dataRef = useRef(data);
  dataRef.current = data;

  const frameKey = `${hash}-${runKey}`;
  // 同一个 iframe 第二次 load 说明代码试图跳转（已被 frame-src 拦下）
  const loads = useRef({ key: "", n: 0 });
  const onNavigate = useRef<() => void>(undefined);
  const onLoad = () => {
    if (loads.current.key !== frameKey) loads.current = { key: frameKey, n: 0 };
    if (++loads.current.n >= 2) onNavigate.current?.();
  };

  const sendData = () => ref.current?.contentWindow?.postMessage({ __minder: 1, type: "data", data: dataRef.current }, "*");

  // 每次（重新）运行：清空状态，收集 ready 之后一小段时间内的报错，再上报给服务端
  useEffect(() => {
    setError(null);
    setReady(false);
    let err: string | null = null;
    let reported = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      reported = true;
      client.send({ type: "widget:status", id: node.id, hash, error: err });
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data?.__minder) return;
      const m = e.data;
      if (m.type === "resize" && typeof m.h === "number") {
        setHeight(Math.max(MIN_H, Math.min(MAX_H, m.h)));
      } else if (m.type === "error" && typeof m.message === "string") {
        err ??= m.message.slice(0, 2000);
        setError(err);
        if (reported) report();
      } else if (m.type === "ready") {
        setReady(true);
        sendData();
        // 给异步代码（定时器、第一次拿到数据后的渲染）一点时间暴露错误
        timer = setTimeout(report, 500);
      }
    };
    onNavigate.current = () => {
      err ??= "组件试图跳转页面，已被阻止";
      setError(err);
      report();
    };
    window.addEventListener("message", onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [node.id, hash, runKey]);

  // 白板变化时推给组件（节流，AI 流式写节点时不至于每个 token 都推）
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(sendData, 200);
    return () => clearTimeout(t);
  }, [data, ready]);

  return (
    <div className={`widget ${active ? "active nodrag nowheel" : ""}`}>
      <iframe
        key={frameKey}
        ref={ref}
        onLoad={onLoad}
        title={node.title || "组件"}
        sandbox="allow-scripts"
        srcDoc={doc}
        style={{ height }}
      />
      {/* 没选中时盖一层，让拖动、缩放白板不被 iframe 吃掉；选中后才能和组件交互 */}
      {!active && <div className="widget-shield" title="选中后可交互" />}
      {error && (
        <div className="widget-error nodrag">
          <span className="msg">运行出错：{error.split("\n")[0]}</span>
          <button
            onClick={() =>
              client.send({
                type: "chat",
                text: `组件「${node.title}」运行报错，请修复：\n${error}`,
                mode: "queue",
                contextNodeIds: [node.id],
              })
            }
          >
            让 AI 修复
          </button>
        </div>
      )}
    </div>
  );
}
