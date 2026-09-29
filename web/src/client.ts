import type {
  Board,
  BoardMeta,
  ModelInfo,
  Source,
  ThinkingLevel,
  BoardEdge,
  BoardGroup,
  BoardNode,
  ChatEntry,
  ClientMsg,
  ConversationMeta,
  GroupPatch,
  NodePatch,
  QueueState,
  ServerMsg,
  Task,
  VersionMeta,
} from "../../server/types.ts";
import { animator } from "./animator.ts";

export interface ClientState {
  connected: boolean;
  nodes: Map<string, BoardNode>;
  edges: Map<string, BoardEdge>;
  groups: Map<string, BoardGroup>;
  chat: ChatEntry[];
  /** 这块白板上的所有对话，current 是正在进行的 */
  conversations: ConversationMeta[];
  conversation: string | null;
  tasks: Map<string, Task>;
  queue: QueueState;
  busy: boolean;
  errors: { id: number; message: string }[];
  versions: VersionMeta[];
  head: string | null;
  boards: BoardMeta[];
  board: string;
  models: ModelInfo[];
  model: string | null;
  thinking: ThinkingLevel;
  sources: Source[];
  /** 用过的本地目录（全局记忆） */
  recentDirs: { path: string; name: string; lastUsed: number }[];
  /** 正在对比的历史版本 */
  compare: { id: string; label: string; board: Board } | null;
}

type Listener = () => void;

class Client {
  state: ClientState = {
    connected: false,
    nodes: new Map(),
    edges: new Map(),
    groups: new Map(),
    chat: [],
    conversations: [],
    conversation: null,
    tasks: new Map(),
    queue: { steering: [], followUp: [] },
    busy: false,
    errors: [],
    versions: [],
    head: null,
    boards: [],
    board: "",
    models: [],
    model: null,
    thinking: "low",
    sources: [],
    compare: null,
    recentDirs: [],
  };
  private listeners = new Set<Listener>();
  private ws: WebSocket | undefined;
  private outbox: ClientMsg[] = [];
  /** 新建后需要立即进入编辑状态的节点 */
  editRequest: string | undefined;

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.set({ connected: true });
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onclose = () => {
      this.set({ connected: false });
      setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (ev) => this.receive(JSON.parse(ev.data));
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.outbox.push(msg);
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private receive(msg: ServerMsg) {
    const s = this.state;
    switch (msg.type) {
      case "snapshot":
        animator.reset();
        this.set({ compare: null });
        this.loadBoard(msg.board);
        this.set({ tasks: new Map(msg.tasks.map((t) => [t.id, t])), queue: msg.queue, busy: msg.busy });
        break;
      case "board:replace":
        animator.reset();
        this.set({ compare: null });
        this.loadBoard(msg.board);
        break;
      case "version:board": {
        const meta = s.versions.find((v) => v.id === msg.id);
        this.set({ compare: { id: msg.id, label: meta?.label ?? "历史版本", board: msg.board } });
        break;
      }
      case "recentDirs":
        this.set({ recentDirs: msg.dirs });
        break;
      case "sources":
        this.set({ sources: msg.sources });
        break;
      case "boards":
        this.set({ boards: msg.boards, board: msg.current });
        break;
      case "models":
        this.set({ models: msg.models, model: msg.current, thinking: msg.thinking });
        break;
      case "versions":
        this.set({ versions: msg.versions, head: msg.head });
        break;
      case "node:upsert": {
        const nodes = new Map(s.nodes);
        const isNew = !nodes.has(msg.node.id);
        nodes.set(msg.node.id, msg.node);
        this.set({ nodes });
        // 草稿节点出现时镜头顺带跟过去（已在视野内则不动）
        if (isNew && msg.node.draft) animator.focus?.(msg.node.id);
        if (isNew && msg.animate === "create") {
          animator.enqueue(msg.node.id, "summary", "", summaryOf(msg.node), "AI", "create");
        }
        break;
      }
      case "node:edit":
        // 组件代码的改动不逐字播放，直接重新运行
        if (msg.field === "md" && s.nodes.get(msg.id)?.kind === "widget") break;
        animator.enqueue(msg.id, msg.field ?? "md", msg.before, msg.after, msg.by);
        break;
      case "node:delete": {
        const nodes = new Map(s.nodes);
        nodes.delete(msg.id);
        this.set({ nodes });
        break;
      }
      case "edge:add": {
        const edges = new Map(s.edges);
        edges.set(msg.edge.id, msg.edge);
        this.set({ edges });
        break;
      }
      case "edge:delete": {
        const edges = new Map(s.edges);
        edges.delete(msg.id);
        this.set({ edges });
        break;
      }
      case "group:upsert": {
        const groups = new Map(s.groups);
        groups.set(msg.group.id, msg.group);
        this.set({ groups });
        break;
      }
      case "group:delete": {
        const groups = new Map(s.groups);
        groups.delete(msg.id);
        this.set({ groups });
        break;
      }
      case "chat:upsert": {
        const i = s.chat.findIndex((c) => c.id === msg.entry.id);
        const chat = i >= 0 ? s.chat.map((c, j) => (j === i ? msg.entry : c)) : [...s.chat, msg.entry];
        this.set({ chat });
        break;
      }
      case "chat:replace":
        this.set({ chat: msg.chat });
        break;
      case "conversations":
        this.set({ conversations: msg.conversations, conversation: msg.current });
        break;
      case "chat:delta": {
        const field = msg.field ?? "text";
        this.set({ chat: s.chat.map((c) => (c.id === msg.id ? { ...c, [field]: (c[field] ?? "") + msg.delta } : c)) });
        break;
      }
      case "queue":
        this.set({ queue: msg.queue });
        break;
      case "busy":
        this.set({ busy: msg.busy });
        break;
      case "task:upsert": {
        const tasks = new Map(s.tasks);
        tasks.set(msg.task.id, msg.task);
        this.set({ tasks });
        break;
      }
      case "task:delta": {
        const t = s.tasks.get(msg.id);
        if (!t) break;
        const tasks = new Map(s.tasks);
        tasks.set(t.id, { ...t, log: t.log + msg.delta });
        this.set({ tasks });
        break;
      }
      case "error": {
        const id = Date.now() + Math.random();
        this.set({ errors: [...s.errors, { id, message: msg.message }] });
        setTimeout(() => this.set({ errors: this.state.errors.filter((e) => e.id !== id) }), 6000);
        break;
      }
    }
  }

  private loadBoard(board: Board) {
    this.set({
      nodes: new Map(board.nodes.map((n) => [n.id, n])),
      edges: new Map(board.edges.map((e) => [e.id, e])),
      groups: new Map((board.groups ?? []).map((g) => [g.id, g])),
      chat: board.chat ?? [],
    });
  }

  /** 本地立即更新并同步给服务端（避免拖动、折叠等操作等待往返） */
  patchNode(id: string, patch: NodePatch) {
    const n = this.state.nodes.get(id);
    if (!n) return;
    const nodes = new Map(this.state.nodes);
    nodes.set(id, { ...n, ...patch });
    this.set({ nodes });
    this.send({ type: "node:update", id, patch });
  }

  patchGroup(id: string, patch: GroupPatch) {
    const g = this.state.groups.get(id);
    if (!g) return;
    const groups = new Map(this.state.groups);
    groups.set(id, { ...g, ...patch });
    this.set({ groups });
    this.send({ type: "group:update", id, patch });
  }

  /** 把节点打包成新分组（nodeIds 为空则是空分组），新建后直接进入改名 */
  createGroup(nodeIds: string[], pos?: { x: number; y: number }) {
    const id = Math.random().toString(36).slice(2, 10);
    this.editRequest = `group:${id}`;
    this.send({ type: "group:create", id, title: "新分组", nodeIds, ...(pos ?? {}) });
    return id;
  }

  startCompare(versionId: string) {
    this.send({ type: "version:get", id: versionId });
  }

  endCompare() {
    this.set({ compare: null });
  }

  /** 上传参考资料到当前白板 */
  async uploadSources(files: File[], folder?: string) {
    const form = new FormData();
    // 上传文件夹时带上相对路径（去掉最外层的文件夹名）
    for (const f of files) form.append("files", f, folder ? f.webkitRelativePath.split("/").slice(1).join("/") || f.name : f.name);
    const q = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    const res = await fetch(`/api/boards/${this.state.board}/sources${q}`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `上传失败（${res.status}）`);
    return data as { added: string[]; rejected: string[] };
  }

  createNode(parentId: string | null, pos?: { x: number; y: number }, groupId?: string) {
    const id = Math.random().toString(36).slice(2, 10);
    this.editRequest = id;
    this.send({ type: "node:create", id, parentId, groupId, ...(pos ?? {}) });
    return id;
  }
}

export const client = new Client();

/** 节点摘要：优先用 summary，没有则取正文第一行 */
export function summaryOf(n: BoardNode) {
  if (n.summary || n.kind === "widget") return n.summary;
  const line = n.md.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^[#>\-*\d.\s]+/, "").replace(/\*\*/g, "").trim();
}
