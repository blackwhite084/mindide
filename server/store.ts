import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { AskAnswer, Board, BoardEdge, BoardGroup, BoardNode, ChatEntry, EdgePatch, EditField, GroupPatch, ServerMsg, Task } from "./types.ts";
import { codeHash } from "./widget.ts";

type Listener = (msg: ServerMsg) => void;

/** 白板状态 + 持久化 + 变更广播 */
export class BoardStore {
  board: Board = { nodes: [], edges: [], groups: [], chat: [] };
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
    if (msg.type !== "queue" && msg.type !== "busy" && msg.type !== "history") this.scheduleSave();
  }

  private closed = false;

  /** 白板被删除时停止写盘 */
  close() {
    this.closed = true;
    clearTimeout(this.saveTimer);
    this.listeners.clear();
  }

  private scheduleSave() {
    if (this.closed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  /** 立即写盘（退出前调用） */
  flush() {
    if (this.closed) return;
    clearTimeout(this.saveTimer);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ board: this.board, tasks: [...this.tasks.values()] }, null, 2));
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

  /** 所在主题（根节点） */
  rootOf(id: string) {
    let n = this.get(id);
    while (n?.parentId) {
      const p = this.get(n.parentId);
      if (!p) break;
      n = p;
    }
    return n;
  }

  /** 节点所在的分组：由它所在的主题决定 */
  groupOf(id: string) {
    return this.rootOf(id)?.groupId;
  }

  isDescendant(id: string, ancestorId: string): boolean {
    for (let n = this.get(id); n?.parentId; n = this.get(n.parentId)) {
      if (n.parentId === ancestorId) return true;
    }
    return false;
  }

  /** 所有标签及使用次数 */
  tagCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const n of this.board.nodes) for (const t of n.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  }

  addRemoveTags(id: string, add: string[] = [], remove: string[] = []) {
    const node = this.get(id);
    if (!node) return;
    const drop = new Set(normalizeTags(remove));
    const tags = normalizeTags([...(node.tags ?? []), ...add]).filter((t) => !drop.has(t));
    if (tags.join("\n") === (node.tags ?? []).join("\n")) return node;
    return this.updateNode(id, { tags });
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
    if (node.tags) {
      node.tags = normalizeTags(node.tags);
      if (!node.tags.length) delete node.tags;
    }
    if (node.parentId && !this.get(node.parentId)) node.parentId = null;
    if (node.parentId || (node.groupId && !this.getGroup(node.groupId))) delete node.groupId;
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
    if (patch.tags) patch.tags = normalizeTags(patch.tags);
    const groupBefore = this.groupOf(id);
    // 主题从树上断开时留在原来的分组；挂到别的节点下则跟随新的主题
    if (patch.parentId === null && node.parentId && !("groupId" in patch)) patch.groupId = groupBefore;
    Object.assign(node, patch, { updatedAt: Date.now() });
    if (node.tags && !node.tags.length) delete node.tags;
    if (node.parentId || !node.groupId || !this.getGroup(node.groupId)) delete node.groupId;
    // 换了分组：原来固定的位置是相对旧分组的，不再有意义
    if (this.groupOf(id) !== groupBefore) {
      if (patch.x === undefined) node.pinned = false;
      this.unpinDescendants(id);
    }
    this.emit({ type: "node:upsert", node });
    return node;
  }

  private unpinDescendants(id: string) {
    for (const c of this.children(id)) {
      if (c.pinned) {
        c.pinned = false;
        this.emit({ type: "node:upsert", node: c });
      }
      this.unpinDescendants(c.id);
    }
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

  // ---------- 分组 ----------

  getGroup(id: string) {
    return this.board.groups.find((g) => g.id === id);
  }

  resolveGroup(idOrPrefix: string) {
    return this.getGroup(idOrPrefix) ?? this.board.groups.find((g) => g.id.startsWith(idOrPrefix));
  }

  /** 新建分组并装入节点；pos 给出时分组固定在那里，否则参与自动排列 */
  createGroup(init: { id?: string; title: string; nodeIds?: string[]; pos?: { x: number; y: number } }): BoardGroup {
    const ids = this.topMost(init.nodeIds ?? []);
    // 自动排列时放在成员原来所在主题的位置上，而不是排到最后
    const orders = ids.map((id) => this.rootOf(id)!.createdAt);
    const now = Date.now();
    const group: BoardGroup = {
      id: init.id && !this.getGroup(init.id) ? init.id : nanoid(8),
      title: init.title,
      x: init.pos?.x ?? 0,
      y: init.pos?.y ?? 0,
      pinned: !!init.pos,
      fold: false,
      order: orders.length ? Math.min(...orders) - 0.5 : now,
      createdAt: now,
    };
    this.board.groups.push(group);
    this.emit({ type: "group:upsert", group });
    for (const id of ids) this.moveToGroup(id, group.id);
    return group;
  }

  updateGroup(id: string, patch: GroupPatch) {
    const group = this.getGroup(id);
    if (!group) return;
    Object.assign(group, stripUndefined(patch));
    this.emit({ type: "group:upsert", group });
    return group;
  }

  /** withContent：连同里面的卡片一起删除；否则解散，主题变成未分组的 */
  deleteGroup(id: string, withContent = false) {
    if (!this.getGroup(id)) return;
    if (withContent) {
      const ids = new Set(this.board.nodes.filter((n) => this.groupOf(n.id) === id).map((n) => n.id));
      const removed = this.board.edges.filter((e) => ids.has(e.source) || ids.has(e.target));
      this.board.nodes = this.board.nodes.filter((n) => !ids.has(n.id));
      this.board.edges = this.board.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
      for (const e of removed) this.emit({ type: "edge:delete", id: e.id });
      for (const nid of ids) this.emit({ type: "node:delete", id: nid });
    } else {
      for (const n of this.board.nodes.filter((n) => !n.parentId && n.groupId === id)) this.moveToGroup(n.id, null);
    }
    this.board.groups = this.board.groups.filter((g) => g.id !== id);
    this.emit({ type: "group:delete", id });
  }

  /**
   * 把节点（连同子树）移到分组里（null 为不分组）。分组只装完整的主题，
   * 所以非主题会从原树上断开；跨分组时留一条关系线指回原来的父节点。
   */
  moveToGroup(id: string, groupId: string | null, pos?: { x: number; y: number }) {
    const node = this.get(id);
    if (!node || (groupId && !this.getGroup(groupId))) return;
    const oldParent = node.parentId;
    this.updateNode(id, {
      parentId: null,
      groupId: groupId ?? undefined,
      ...(pos ? { x: pos.x, y: pos.y, pinned: true } : { pinned: false }),
    });
    if (oldParent && this.groupOf(oldParent) !== (groupId ?? undefined)) this.addEdge(id, oldParent, { label: "来自" });
    return node;
  }

  /** 去掉祖先也在列表里的节点 */
  private topMost(ids: string[]) {
    const set = new Set(ids.map((id) => this.resolve(id)?.id).filter(Boolean) as string[]);
    return [...set].filter((id) => ![...set].some((a) => a !== id && this.isDescendant(id, a)));
  }

  findEdge(a: string, b: string) {
    return this.board.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  }

  addEdge(source: string, target: string, patch: EdgePatch = {}): BoardEdge | undefined {
    if (source === target || !this.get(source) || !this.get(target)) return;
    const exists = this.findEdge(source, target);
    if (exists) {
      // 已有关系：按新的方向理解，更新文字和箭头
      if (exists.source !== source) {
        [exists.source, exists.target] = [exists.target, exists.source];
        [exists.label, exists.reverseLabel] = [exists.reverseLabel, exists.label];
      }
      return this.updateEdge(exists.id, patch);
    }
    const edge: BoardEdge = { id: nanoid(8), source, target, dir: "forward", ...stripUndefined(patch) };
    this.board.edges.push(edge);
    this.emit({ type: "edge:add", edge });
    return edge;
  }

  reverseEdge(id: string) {
    const edge = this.board.edges.find((e) => e.id === id);
    if (!edge) return;
    [edge.source, edge.target] = [edge.target, edge.source];
    if (edge.dir === "both") [edge.label, edge.reverseLabel] = [edge.reverseLabel, edge.label];
    this.emit({ type: "edge:add", edge });
  }

  updateEdge(id: string, patch: EdgePatch) {
    const edge = this.board.edges.find((e) => e.id === id);
    if (!edge) return;
    Object.assign(edge, stripUndefined(patch));
    if (edge.dir !== "both" || !edge.reverseLabel) delete edge.reverseLabel;
    if (!edge.label) delete edge.label;
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

  appendChat(id: string, delta: string, field: "text" | "thinking" = "text") {
    const entry = this.getChat(id);
    if (!entry) return;
    entry[field] = (entry[field] ?? "") + delta;
    this.emit({ type: "chat:delta", id, delta, field });
  }

  replaceChat(chat: ChatEntry[]) {
    this.board.chat = chat;
    this.emit({ type: "chat:replace", chat });
  }

  replaceBoard(board: Board) {
    this.board = normalizeBoard(board);
    this.emit({ type: "board:replace", board: this.board });
  }

  /** 导入一组节点和关系；merge 时重新分配 id，避免和现有节点冲突 */
  importNodes(
    mode: "replace" | "merge",
    nodes: Pick<BoardNode, "id" | "title" | "summary" | "md" | "parentId" | "kind" | "tags">[],
    edges: Pick<BoardEdge, "source" | "target" | "dir" | "label" | "reverseLabel">[],
    parentId: string | null = null,
  ) {
    const idMap = new Map<string, string>();
    for (const n of nodes) idMap.set(n.id, mode === "replace" ? n.id : nanoid(8));
    const now = Date.now();
    const imported: BoardNode[] = nodes.map((n, i) => ({
      id: idMap.get(n.id)!,
      kind: n.kind === "task" || n.kind === "widget" ? n.kind : "note",
      title: n.title ?? "",
      summary: n.summary ?? "",
      md: n.md ?? "",
      ...(Array.isArray(n.tags) && normalizeTags(n.tags).length ? { tags: normalizeTags(n.tags) } : {}),
      parentId: n.parentId && idMap.has(n.parentId) ? idMap.get(n.parentId)! : mode === "merge" ? parentId : null,
      pinned: false,
      x: 0,
      y: 0,
      open: false,
      fold: false,
      // 保持原有顺序（布局按创建时间排兄弟节点）
      createdAt: now + i,
      updatedAt: now,
    }));
    const importedEdges: BoardEdge[] = edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        id: nanoid(8),
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        dir: e.dir ?? "forward",
        ...stripUndefined({ label: e.label || undefined, reverseLabel: e.reverseLabel || undefined }),
      }));
    if (mode === "replace") {
      this.replaceBoard({ nodes: imported, edges: importedEdges, groups: [], chat: this.board.chat });
    } else {
      this.replaceBoard({
        nodes: [...this.board.nodes, ...imported],
        edges: [...this.board.edges, ...importedEdges],
        groups: this.board.groups,
        chat: this.board.chat,
      });
    }
    return imported.find((n) => !n.parentId || n.parentId === parentId)?.id;
  }

  upsertTask(task: Task) {
    this.tasks.set(task.id, task);
    this.emit({ type: "task:upsert", task });
  }

  // ---------- 组件运行结果（前端上报，不持久化） ----------

  private widgetStatus = new Map<string, { hash: string; error: string | null }>();
  private widgetWaiters = new Set<() => void>();

  reportWidget(id: string, hash: string, error: string | null) {
    this.widgetStatus.set(id, { hash, error });
    for (const fn of this.widgetWaiters) fn();
  }

  /** 当前这版代码的运行结果；还没有前端运行过则为 undefined */
  widgetResult(id: string) {
    const node = this.get(id);
    const s = this.widgetStatus.get(id);
    return node && s && s.hash === codeHash(node.md) ? s : undefined;
  }

  /** 等前端跑完当前这版代码（超时返回 undefined，例如没有打开白板） */
  waitWidget(id: string, timeoutMs = 6000) {
    return new Promise<{ error: string | null } | undefined>((resolve) => {
      const check = () => {
        const s = this.widgetResult(id);
        if (!s) return;
        done();
        resolve(s);
      };
      const done = () => {
        clearTimeout(timer);
        this.widgetWaiters.delete(check);
      };
      const timer = setTimeout(() => {
        done();
        resolve(undefined);
      }, timeoutMs);
      this.widgetWaiters.add(check);
      check();
    });
  }

  // ---------- ask_user 的回答（不持久化） ----------

  private askWaiters = new Map<string, (answers: AskAnswer[] | null) => void>();
  /** 工具开始执行前就收到的回答（流式生成时问题已经显示出来了） */
  private earlyAnswers = new Map<string, AskAnswer[] | null>();

  answerAsk(id: string, answers: AskAnswer[] | null) {
    const fn = this.askWaiters.get(id);
    if (fn) fn(answers);
    else this.earlyAnswers.set(id, answers);
  }

  /** 等用户回答（id 是工具调用 id）；中止时抛错 */
  waitAnswer(id: string, signal?: AbortSignal) {
    return new Promise<AskAnswer[] | null>((resolve, reject) => {
      if (this.earlyAnswers.has(id)) {
        const early = this.earlyAnswers.get(id)!;
        this.earlyAnswers.delete(id);
        return resolve(early);
      }
      const onAbort = () => {
        this.askWaiters.delete(id);
        reject(new Error("提问已取消"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.askWaiters.set(id, (answers) => {
        this.askWaiters.delete(id);
        signal?.removeEventListener("abort", onAbort);
        resolve(answers);
      });
    });
  }

  /** 带某个标签的节点（平铺，注明所在的父节点） */
  private taggedOutline(tag: string) {
    const hits = this.board.nodes.filter((n) => n.tags?.includes(tag));
    if (!hits.length) return `(没有带 #${tag} 标签的节点)`;
    return hits
      .map((n) => {
        const summary = n.summary || (n.kind === "widget" ? "" : firstLine(n.md, 50));
        const parent = n.parentId ? this.get(n.parentId) : undefined;
        return `- [${n.id}] ${n.title || "(无标题)"}${summary ? ` — ${summary}` : ""}${tagText(n)}${parent ? `（属于 [${parent.id}] ${parent.title || "(无标题)"}）` : "（主题）"}`;
      })
      .join("\n");
  }

  /** 给模型看的思维树（缩进表示层级） */
  outline(maxNodes = 150, tag?: string) {
    if (!this.board.nodes.length) return "(白板为空)";
    if (tag) return this.taggedOutline(normalizeTags([tag])[0] ?? tag);
    const lines: string[] = [];
    const walk = (list: BoardNode[], depth: number) => {
      for (const n of list) {
        if (lines.length >= maxNodes) return;
        const summary = n.summary || (n.kind === "widget" ? "" : firstLine(n.md, 50));
        const tag = n.kind === "widget" ? "[组件] " : "";
        lines.push(`${"  ".repeat(depth)}- [${n.id}] ${tag}${n.title || "(无标题)"}${summary ? ` — ${summary}` : ""}${tagText(n)}`);
        walk(this.children(n.id), depth + 1);
      }
    };
    const roots = this.children(null);
    if (!this.board.groups.length) walk(roots, 0);
    else {
      // 有分组时按分组分段
      for (const g of this.board.groups) {
        lines.push(`## 分组 [${g.id}] ${g.title || "(未命名)"}${g.fold ? "（已折叠）" : ""}`);
        const members = roots.filter((n) => n.groupId === g.id);
        if (members.length) walk(members, 0);
        else lines.push("(空)");
      }
      const rest = roots.filter((n) => !n.groupId);
      if (rest.length) {
        lines.push("## 未分组");
        walk(rest, 0);
      }
    }
    const counts = this.tagCounts();
    if (counts.size) lines.push("", "标签（优先复用已有标签）：" + [...counts].map(([t, c]) => `#${t}(${c})`).join(" "));
    if (this.board.edges.length) {
      lines.push("", "关系：");
      for (const e of this.board.edges) {
        const arrow = e.dir === "both" ? "↔" : e.dir === "none" ? "—" : "→";
        const text = [e.label, e.reverseLabel].filter(Boolean).join(" / ");
        lines.push(`- ${e.source} ${arrow} ${e.target}${text ? `：${text}` : ""}`);
      }
    }
    return lines.join("\n");
  }
}

export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw).replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 8);
}

const tagText = (n: BoardNode) => (n.tags?.length ? " " + n.tags.map((t) => `#${t}`).join(" ") : "");

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function normalizeBoard(board: Partial<Board>): Board {
  const nodes = (board.nodes ?? []).filter((n: any) => !n.draft).map((n: any) => ({
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
  const edges = (board.edges ?? []).map((e: any) => ({ dir: "forward", ...e }));
  const groups: BoardGroup[] = (board.groups ?? []).map((g: any) => ({
    title: "",
    x: 0,
    y: 0,
    pinned: false,
    fold: false,
    order: g.createdAt ?? 0,
    ...g,
  }));
  const groupIds = new Set(groups.map((g) => g.id));
  for (const n of nodes) if (n.groupId && (n.parentId || !groupIds.has(n.groupId))) delete n.groupId;
  return { nodes, edges, groups, chat: board.chat ?? [] };
}

export function firstLine(md: string, max = 40) {
  const line = md.split("\n").find((l) => l.trim()) ?? "";
  const s = line.replace(/^[#>\-*\d.\s]+/, "").replace(/\*\*/g, "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
