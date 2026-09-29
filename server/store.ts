import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { Board, BoardEdge, BoardNode, ChatEntry, EditField, ServerMsg, Task } from "./types.ts";

type Listener = (msg: ServerMsg) => void;

/** 白板状态 + 持久化 + 变更广播 */
export class BoardStore {
  board: Board = { nodes: [], edges: [], chat: [] };
  tasks = new Map<string, Task>();
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private file: string) {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.board) this.board = normalizeBoard(data.board);
      for (const t of data.tasks ?? []) {
        if (t.status === "running") t.status = "aborted";
        this.tasks.set(t.id, t);
      }
    }
  }

  onMessage(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(msg: ServerMsg) {
    for (const fn of this.listeners) fn(msg);
    if (msg.type !== "queue" && msg.type !== "busy") this.scheduleSave();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ board: this.board, tasks: [...this.tasks.values()] }, null, 2));
    }, 300);
  }

  get(id: string) {
    return this.board.nodes.find((n) => n.id === id);
  }

  /** 支持用 id 前缀查找，方便模型引用 */
  resolve(idOrPrefix: string) {
    return this.get(idOrPrefix) ?? this.board.nodes.find((n) => n.id.startsWith(idOrPrefix));
  }

  children(id: string | null) {
    return this.board.nodes.filter((n) => n.parentId === id);
  }

  isDescendant(id: string, ancestorId: string): boolean {
    for (let n = this.get(id); n?.parentId; n = this.get(n.parentId)) {
      if (n.parentId === ancestorId) return true;
    }
    return false;
  }

  createNode(init: Partial<BoardNode>, animate = false): BoardNode {
    const now = Date.now();
    const node: BoardNode = {
      id: nanoid(8),
      kind: "note",
      title: "",
      summary: "",
      md: "",
      parentId: null,
      pinned: false,
      x: 0,
      y: 0,
      open: false,
      fold: false,
      createdAt: now,
      updatedAt: now,
      ...init,
    };
    if (node.parentId && !this.get(node.parentId)) node.parentId = null;
    this.board.nodes.push(node);
    this.emit({ type: "node:upsert", node, animate: animate ? "create" : undefined });
    return node;
  }

  updateNode(id: string, patch: Partial<BoardNode>) {
    const node = this.get(id);
    if (!node) return;
    if (patch.parentId !== undefined && patch.parentId !== null) {
      // 不能挂到自己或自己的子孙下面
      if (patch.parentId === id || this.isDescendant(patch.parentId, id) || !this.get(patch.parentId)) {
        delete patch.parentId;
      }
    }
    Object.assign(node, patch, { updatedAt: Date.now() });
    this.emit({ type: "node:upsert", node });
    return node;
  }

  /** 整体替换内容并触发前端的差异动画 */
  editNode(id: string, after: string, by: string, field: EditField = "md") {
    const node = this.get(id);
    if (!node) return;
    const before = node[field];
    if (before === after) return;
    node[field] = after;
    node.lastEdit = { field, before, after, at: Date.now(), by };
    node.updatedAt = Date.now();
    this.emit({ type: "node:edit", id, field, before, after, by });
    this.emit({ type: "node:upsert", node });
  }

  /** 删除节点，子节点上移到它的父节点下 */
  deleteNode(id: string) {
    const node = this.get(id);
    if (!node) return;
    for (const c of this.children(id)) this.updateNode(c.id, { parentId: node.parentId });
    this.board.nodes = this.board.nodes.filter((n) => n.id !== id);
    const removed = this.board.edges.filter((e) => e.source === id || e.target === id);
    this.board.edges = this.board.edges.filter((e) => e.source !== id && e.target !== id);
    for (const e of removed) this.emit({ type: "edge:delete", id: e.id });
    this.emit({ type: "node:delete", id });
  }

  addEdge(source: string, target: string): BoardEdge | undefined {
    if (source === target || !this.get(source) || !this.get(target)) return;
    const exists = this.board.edges.find(
      (e) => (e.source === source && e.target === target) || (e.source === target && e.target === source),
    );
    if (exists) return exists;
    const edge = { id: nanoid(8), source, target };
    this.board.edges.push(edge);
    this.emit({ type: "edge:add", edge });
    return edge;
  }

  deleteEdge(id: string) {
    this.board.edges = this.board.edges.filter((e) => e.id !== id);
    this.emit({ type: "edge:delete", id });
  }

  // ---------- 对话记录 ----------

  addChat(init: Omit<ChatEntry, "id" | "at">): ChatEntry {
    const entry: ChatEntry = { id: nanoid(8), at: Date.now(), ...init };
    this.board.chat.push(entry);
    this.emit({ type: "chat:upsert", entry });
    return entry;
  }

  getChat(id: string) {
    return this.board.chat.find((c) => c.id === id);
  }

  updateChat(id: string, patch: Partial<ChatEntry>) {
    const entry = this.getChat(id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.emit({ type: "chat:upsert", entry });
  }

  appendChat(id: string, delta: string) {
    const entry = this.getChat(id);
    if (!entry) return;
    entry.text += delta;
    this.emit({ type: "chat:delta", id, delta });
  }

  replaceBoard(board: Board) {
    this.board = normalizeBoard(board);
    this.emit({ type: "board:replace", board: this.board });
  }

  upsertTask(task: Task) {
    this.tasks.set(task.id, task);
    this.emit({ type: "task:upsert", task });
  }

  /** 给模型看的思维树（缩进表示层级） */
  outline(maxNodes = 150) {
    if (!this.board.nodes.length) return "(白板为空)";
    const lines: string[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const n of this.children(parentId)) {
        if (lines.length >= maxNodes) return;
        const summary = n.summary || firstLine(n.md, 50);
        lines.push(`${"  ".repeat(depth)}- [${n.id}] ${n.title || "(无标题)"}${summary ? ` — ${summary}` : ""}`);
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    if (this.board.edges.length) {
      lines.push("", "关联：");
      for (const e of this.board.edges) lines.push(`- ${e.source} ↔ ${e.target}`);
    }
    return lines.join("\n");
  }
}

function normalizeBoard(board: Partial<Board>): Board {
  const nodes = (board.nodes ?? []).map((n: any) => ({
    kind: "note",
    summary: "",
    parentId: null,
    pinned: false,
    open: false,
    fold: false,
    ...n,
    x: n.x ?? 0,
    y: n.y ?? 0,
  }));
  return { nodes, edges: board.edges ?? [], chat: board.chat ?? [] };
}

export function firstLine(md: string, max = 40) {
  const line = md.split("\n").find((l) => l.trim()) ?? "";
  const s = line.replace(/^[#>\-*\d.\s]+/, "").replace(/\*\*/g, "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
