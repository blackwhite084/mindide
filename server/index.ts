import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BoardStore } from "./store.ts";
import { MainAgent, TaskRunner } from "./agents.ts";
import { VersionTree } from "./versions.ts";
import type { ClientMsg, ServerMsg } from "./types.ts";

const PORT = Number(process.env.PORT ?? 5174);
const store = new BoardStore(resolve("data/board.json"));
const tasks = new TaskRunner(store);
const main = new MainAgent(store, tasks);
const versions = new VersionTree(resolve("data/versions.json"), store);
await main.init();

main.onSettled = (label) => versions.commit(label, main.messages);
tasks.onFinished = (task) => {
  if (!main.busy) versions.commit(`任务：${task.title}`, main.messages);
};
if (!versions.head) versions.commit("起点", [], true);
else {
  // 重启后恢复当前版本的 AI 对话上下文
  const head = versions.get(versions.head);
  if (head) main.restore(structuredClone(head.messages));
}

// 手动编辑停下来一会儿后记录一个版本
let manualTimer: NodeJS.Timeout | undefined;
function manualEdit() {
  clearTimeout(manualTimer);
  manualTimer = setTimeout(() => {
    if (!main.busy) versions.commit("手动编辑", main.messages);
  }, 2500);
}

const app = Fastify();
await app.register(websocket);

const dist = resolve("web/dist");
if (existsSync(dist)) await app.register(fastifyStatic, { root: dist });

app.get("/ws", { websocket: true }, (socket) => {
  const send = (msg: ServerMsg) => socket.readyState === 1 && socket.send(JSON.stringify(msg));
  send({
    type: "snapshot",
    board: store.board,
    tasks: [...store.tasks.values()],
    queue: main.queueState(),
    busy: main.busy,
  });
  send({ type: "versions", versions: versions.metas(), head: versions.head });
  const off = store.onMessage(send);
  socket.on("close", off);
  socket.on("message", (raw: Buffer) => {
    try {
      handle(JSON.parse(String(raw)) as ClientMsg).catch((err) => send({ type: "error", message: String(err?.message ?? err) }));
    } catch (err: any) {
      send({ type: "error", message: err?.message ?? String(err) });
    }
  });
});

const MANUAL = new Set(["node:update", "node:create", "node:delete", "node:revert", "edge:add", "edge:delete"]);

async function handle(msg: ClientMsg) {
  const layoutOnly = msg.type === "node:update" && Object.keys(msg.patch).every((k) => ["x", "y", "pinned", "open", "fold"].includes(k));
  if (MANUAL.has(msg.type) && !layoutOnly) manualEdit();
  switch (msg.type) {
    case "chat":
      if (msg.text.trim()) main.chat(msg.text.trim(), msg.mode, msg.contextNodeIds);
      break;
    case "abort":
      main.abort();
      break;
    case "queue:clear":
      main.clearQueue();
      break;
    case "node:update":
      store.updateNode(msg.id, msg.patch);
      break;
    case "node:create":
      if (store.get(msg.id)) break;
      store.createNode({
        id: msg.id,
        parentId: msg.parentId,
        open: true,
        ...(msg.x !== undefined && msg.y !== undefined ? { x: msg.x, y: msg.y, pinned: true } : {}),
      });
      break;
    case "node:delete":
      store.deleteNode(msg.id);
      break;
    case "node:revert": {
      const node = store.get(msg.id);
      if (node?.lastEdit) store.editNode(node.id, node.lastEdit.before, "撤销", node.lastEdit.field ?? "md");
      break;
    }
    case "edge:add":
      store.addEdge(msg.source, msg.target);
      break;
    case "edge:delete":
      store.deleteEdge(msg.id);
      break;
    case "task:create":
      tasks.run(msg.kind, "", msg.instructions, msg.contextNodeIds);
      break;
    case "task:steer":
      tasks.steer(msg.id, msg.text);
      break;
    case "task:abort":
      tasks.abort(msg.id);
      break;
    case "version:save":
      versions.commit(msg.label || "手动保存", main.messages, true);
      break;
    case "version:checkout": {
      clearTimeout(manualTimer);
      await main.stop();
      // 离开前把当前未记录的改动存下来，避免丢失
      versions.commit("自动保存", main.messages);
      const snap = versions.checkout(msg.id);
      if (!snap) break;
      store.replaceBoard(snap.board);
      main.restore(snap.messages);
      break;
    }
  }
}

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[server] http://127.0.0.1:${PORT}`);
