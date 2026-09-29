import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { WEB_DIST } from "./paths.ts";
import { isSupported } from "./sources.ts";
import { listModels } from "./agents.ts";
import { BoardManager } from "./boards.ts";
import { saveSettings, settings } from "./settings.ts";
import type { ClientMsg, ServerMsg } from "./types.ts";
import type { Workspace } from "./workspace.ts";

const PORT = Number(process.env.PORT ?? 5174);
const boards = new BoardManager();
await boards.get(boards.current);
const models = await listModels();

type Send = (msg: ServerMsg) => void;
/** 每个连接各自在看哪块白板 */
const clients = new Map<Send, () => string>();
const broadcast = (msg: ServerMsg) => clients.forEach((_, send) => send(msg));
const boardsMsg = (current: string): ServerMsg => ({ type: "boards", boards: boards.list(), current });
const broadcastBoards = () => clients.forEach((current, send) => send(boardsMsg(current())));

async function modelsMsg(): Promise<ServerMsg> {
  const ws = await boards.get(boards.current);
  return { type: "models", models, current: settings.model ?? ws.main.modelKey, thinking: settings.thinking };
}

boards.onChange = broadcastBoards;

const app = Fastify({ bodyLimit: 1024 * 1024 });
await app.register(websocket);
// preservePath：上传文件夹时文件名带相对路径
await app.register(multipart, { preservePath: true, limits: { fileSize: 100 * 1024 * 1024, files: 5000 } });

/** 上传参考资料（可多选）。以后做成产品时，上传整个文件夹也走这里 */
app.post<{ Params: { board: string }; Querystring: { folder?: string } }>("/api/boards/:board/sources", async (req, reply) => {
  if (!boards.has(req.params.board)) return reply.code(404).send({ error: "白板不存在" });
  const ws = await boards.get(req.params.board);
  const added: string[] = [];
  const rejected: string[] = [];
  // 上传文件夹：文件名是相对路径，整体作为一个目录资料
  if (req.query.folder) {
    const files: { path: string; buf: Buffer }[] = [];
    for await (const part of req.files()) {
      if (!isSupported(part.filename)) {
        part.file.resume();
        continue;
      }
      files.push({ path: part.filename, buf: await part.toBuffer() });
    }
    ws.sources.addUploadedFolder(req.query.folder, files);
    return { added: [`${req.query.folder}/（${files.length} 个文件）`], rejected };
  }
  for await (const part of req.files()) {
    if (!isSupported(part.filename)) {
      rejected.push(part.filename);
      part.file.resume();
      continue;
    }
    const buf = await part.toBuffer();
    // 提取文字可能较慢，后台处理，状态通过 sources 消息推送
    ws.sources.addUpload(part.filename, buf);
    added.push(part.filename);
  }
  return { added, rejected };
});

/** 本地目录浏览（选择代码库等目录用，仅本机服务） */
app.get<{ Querystring: { path?: string } }>("/api/fs/dirs", async (req, reply) => {
  const raw = req.query.path?.trim() || homedir();
  const abs = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const markers = entries.filter((e) => [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"].includes(e.name)).map((e) => e.name);
    return { path: abs, parent: dirname(abs) === abs ? null : dirname(abs), dirs, project: markers.length > 0, home: homedir() };
  } catch (err: any) {
    return reply.code(400).send({ error: `无法读取目录：${abs}` });
  }
});

if (existsSync(WEB_DIST)) await app.register(fastifyStatic, { root: WEB_DIST });

app.get("/ws", { websocket: true }, async (socket) => {
  const send: Send = (msg) => socket.readyState === 1 && socket.send(JSON.stringify(msg));
  let ws: Workspace | undefined;
  let off: (() => void) | undefined;

  /** 把这个连接挂到某块白板上 */
  const attach = async (id: string) => {
    off?.();
    ws = await boards.get(id);
    off = ws.store.onMessage(send);
    for (const m of ws.snapshot()) send(m);
  };

  clients.set(send, () => ws?.id ?? boards.current);
  socket.on("close", () => {
    clients.delete(send);
    off?.();
  });

  // 先注册消息处理，避免初始化期间丢消息
  const ready = (async () => {
    send(boardsMsg(boards.current));
    send(await modelsMsg());
    await attach(boards.current);
  })();

  socket.on("message", async (raw: Buffer) => {
    try {
      await ready;
      // 所在白板被别的窗口删掉了：切到当前白板
      if (ws && !boards.has(ws.id)) await attach(boards.current);
      const msg = JSON.parse(String(raw)) as ClientMsg;
      await handle(msg, ws!, attach, send);
      if (msg.type.startsWith("boards:")) broadcastBoards();
    } catch (err: any) {
      send({ type: "error", message: err?.message ?? String(err) });
    }
  });
});

async function handle(msg: ClientMsg, ws: Workspace, attach: (id: string) => Promise<void>, send: Send) {
  switch (msg.type) {
    case "version:get": {
      const v = ws.versions.get(msg.id);
      if (v) send({ type: "version:board", id: v.id, board: v.board });
      return;
    }
    case "boards:switch":
      if (!boards.has(msg.id)) return;
      boards.switchTo(msg.id);
      await attach(msg.id);
      return;
    case "boards:create": {
      const meta = boards.create(msg.name);
      boards.switchTo(meta.id);
      await attach(meta.id);
      return;
    }
    case "boards:rename":
      boards.rename(msg.id, msg.name);
      return;
    case "boards:delete": {
      const next = await boards.remove(msg.id);
      // 正在看被删白板的连接会在下一条消息时发现；当前连接直接切走
      if (ws.id === msg.id) await attach(next);
      return;
    }
    case "model:set":
      if (!models.some((m) => m.key === msg.key)) return;
      saveSettings({ model: msg.key });
      await Promise.all(boards.workspaces().map((w) => w.main.applyModel()));
      broadcast(await modelsMsg());
      return;
    case "thinking:set":
      saveSettings({ thinking: msg.level });
      await Promise.all(boards.workspaces().map((w) => w.main.applyModel()));
      broadcast(await modelsMsg());
      return;
    default:
      await ws.handle(msg);
  }
}

// 退出（包括开发模式下的自动重启）前把内存里的状态落盘
let exiting = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (exiting) return;
    exiting = true;
    for (const ws of boards.workspaces()) {
      try {
        ws.shutdown();
      } catch (err) {
        console.error(`[shutdown] ${ws.id}`, err);
      }
    }
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });
console.log(`[server] http://127.0.0.1:${PORT}`);
