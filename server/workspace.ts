import { join } from "node:path";
import { MainAgent, TaskRunner } from "./agents.ts";
import { ConversationStore } from "./conversations.ts";
import { SourceLibrary } from "./sources.ts";
import { BoardStore } from "./store.ts";
import type { ClientMsg, ServerMsg } from "./types.ts";
import { LEGACY_CONVERSATION, VersionTree } from "./versions.ts";

const MANUAL = new Set([
  "node:update",
  "node:create",
  "node:delete",
  "node:revert",
  "edge:add",
  "edge:update",
  "edge:reverse",
  "edge:delete",
  "node:restore",
  "group:create",
  "group:update",
  "group:delete",
  "node:toGroup",
]);
const LAYOUT_ONLY = ["x", "y", "pinned", "open", "fold"];

/** 一块白板：内容、版本树、主对话 agent 和后台任务，彼此独立 */
export class Workspace {
  readonly store: BoardStore;
  readonly tasks: TaskRunner;
  readonly main: MainAgent;
  readonly versions: VersionTree;
  readonly sources: SourceLibrary;
  readonly conversations: ConversationStore;
  private manualTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: string,
    dir: string,
  ) {
    this.store = new BoardStore(join(dir, "board.json"));
    this.sources = new SourceLibrary(dir);
    this.sources.onChange = () => this.store.emit({ type: "sources", sources: this.sources.list() });
    this.tasks = new TaskRunner(this.store, this.sources);
    this.main = new MainAgent(this.store, this.tasks, this.sources);
    this.conversations = new ConversationStore(join(dir, "conversations.json"));
    this.versions = new VersionTree(join(dir, "versions.json"), this.store, () => this.conversations.current);
  }

  async init() {
    await this.main.init();
    this.main.onSettled = (label) => {
      this.versions.commit(label, this.main.messages);
      this.syncConversation();
    };
    this.tasks.onFinished = (task) => {
      if (!this.main.busy) this.versions.commit(`任务：${task.title}`, this.main.messages);
    };
    const current = this.conversations.current ? this.conversations.get(this.conversations.current) : undefined;
    if (current) {
      // 重新加载后恢复当前对话的 AI 上下文
      this.main.restore(structuredClone(current.messages));
    } else {
      // 还没有多对话时：现有的对话记录和版本里的上下文就是默认对话
      const head = this.versions.head ? this.versions.get(this.versions.head) : undefined;
      const messages = head && (head.conversationId ?? LEGACY_CONVERSATION) === LEGACY_CONVERSATION ? head.messages : [];
      this.conversations.create(LEGACY_CONVERSATION, structuredClone(this.store.board.chat), structuredClone(messages));
      this.main.restore(structuredClone(messages));
    }
    if (!this.versions.head) this.versions.commit("起点", [], true);
  }

  private syncConversation() {
    this.conversations.sync(this.store.board.chat, this.main.messages);
    this.broadcastConversations();
  }

  private broadcastConversations() {
    this.store.emit(this.conversationsMsg());
  }

  private conversationsMsg(): ServerMsg {
    return { type: "conversations", conversations: this.conversations.metas(), current: this.conversations.current };
  }

  /** 离开当前对话：停下 AI，存好当前对话 */
  private async leaveConversation() {
    clearTimeout(this.manualTimer);
    await this.main.stop();
    this.versions.commit("自动保存", this.main.messages);
    this.conversations.sync(this.store.board.chat, this.main.messages);
  }

  private enterConversation(id: string) {
    const c = this.conversations.activate(id);
    this.store.replaceChat(structuredClone(c.chat));
    this.main.restore(structuredClone(c.messages));
    this.broadcastConversations();
  }

  /** 客户端切到这块白板时需要的全部状态 */
  snapshot(): ServerMsg[] {
    return [
      {
        type: "snapshot",
        board: this.store.board,
        tasks: [...this.store.tasks.values()],
        queue: this.main.queueState(),
        busy: this.main.busy,
      },
      { type: "versions", versions: this.versions.metas(), head: this.versions.head },
      this.conversationsMsg(),
      { type: "sources", sources: this.sources.list() },
    ];
  }

  get nodeCount() {
    return this.store.board.nodes.filter((n) => !n.draft).length;
  }

  /** 服务退出前：把最新的白板和 AI 对话上下文存进版本，重启后 AI 不会“失忆” */
  shutdown() {
    clearTimeout(this.manualTimer);
    try {
      this.versions.commit("自动保存（退出前）", this.main.messages);
      this.conversations.sync(this.store.board.chat, this.main.messages);
    } finally {
      this.store.flush();
      this.versions.flush();
      this.conversations.flush();
    }
  }

  dispose() {
    clearTimeout(this.manualTimer);
    this.main.dispose();
    this.tasks.dispose();
    this.store.close();
    this.versions.close();
    this.conversations.close();
  }

  /** 手动编辑停下来一会儿后记录一个版本 */
  private manualEdit() {
    clearTimeout(this.manualTimer);
    this.manualTimer = setTimeout(() => {
      if (!this.main.busy) this.versions.commit("手动编辑", this.main.messages);
    }, 2500);
  }

  async handle(msg: ClientMsg) {
    const { store, main, tasks, versions } = this;
    const layoutOnly =
      (msg.type === "node:update" || msg.type === "group:update") && Object.keys(msg.patch).every((k) => LAYOUT_ONLY.includes(k));
    if (MANUAL.has(msg.type) && !layoutOnly) this.manualEdit();
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
      case "chat:new":
        if (!store.board.chat.length) break;
        await this.leaveConversation();
        this.enterConversation(this.conversations.create().id);
        break;
      case "chat:open":
        if (msg.id === this.conversations.current || !this.conversations.get(msg.id)) break;
        await this.leaveConversation();
        this.enterConversation(msg.id);
        break;
      case "chat:delete":
        if (msg.id !== this.conversations.current) {
          this.conversations.remove(msg.id);
          this.broadcastConversations();
          break;
        }
        await main.stop();
        this.conversations.remove(msg.id);
        this.enterConversation(this.conversations.create().id);
        break;
      case "node:update":
        store.updateNode(msg.id, msg.patch);
        break;
      case "node:create":
        if (store.get(msg.id)) break;
        store.createNode({
          id: msg.id,
          parentId: msg.parentId,
          groupId: msg.groupId,
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
      case "edge:update":
        store.updateEdge(msg.id, msg.patch);
        break;
      case "edge:reverse":
        store.reverseEdge(msg.id);
        break;
      case "group:create":
        store.createGroup({
          id: msg.id,
          title: msg.title,
          nodeIds: msg.nodeIds,
          pos: msg.x !== undefined && msg.y !== undefined ? { x: msg.x, y: msg.y } : undefined,
        });
        break;
      case "group:update":
        store.updateGroup(msg.id, msg.patch);
        break;
      case "group:delete":
        store.deleteGroup(msg.id, msg.withContent);
        break;
      case "node:toGroup":
        store.moveToGroup(msg.id, msg.groupId, msg.x !== undefined && msg.y !== undefined ? { x: msg.x, y: msg.y } : undefined);
        break;
      case "task:create":
        tasks.run("", msg.instructions, msg.contextNodeIds);
        break;
      case "task:steer":
        tasks.steer(msg.id, msg.text);
        break;
      case "task:abort":
        tasks.abort(msg.id);
        break;
      case "board:import": {
        clearTimeout(this.manualTimer);
        await main.stop();
        versions.commit("导入前", main.messages);
        store.importNodes(msg.mode, msg.nodes, msg.edges, msg.parentId ?? null);
        versions.commit(`导入：${msg.name}`, main.messages, true);
        break;
      }
      case "sources:bash":
        this.sources.setBash(msg.id, msg.allow);
        break;
      case "widget:status":
        store.reportWidget(msg.id, msg.hash, msg.error);
        break;
      case "sources:remove":
        this.sources.remove(msg.id);
        break;
      case "node:restore": {
        const n = msg.node;
        if (store.get(n.id)) break;
        store.createNode(
          {
            ...n,
            parentId: n.parentId && store.get(n.parentId) ? n.parentId : null,
            draft: false,
            lastEdit: undefined,
            createdAt: n.createdAt,
          },
          true,
        );
        break;
      }
      case "version:save":
        versions.commit(msg.label || "手动保存", main.messages, true);
        break;
      case "version:checkout": {
        // 离开前把当前未记录的改动存下来，避免丢失
        await this.leaveConversation();
        const snap = versions.checkout(msg.id);
        if (!snap) break;
        store.replaceBoard(snap.board);
        main.restore(snap.messages);
        // 回到该版本所在的对话，并回退到当时的进度
        this.conversations.activate(snap.conversationId, structuredClone(snap.board.chat), structuredClone(snap.messages));
        this.broadcastConversations();
        break;
      }
    }
  }
}
