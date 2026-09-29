import { join } from "node:path";
import { MainAgent, TaskRunner } from "./agents.ts";
import { SourceLibrary } from "./sources.ts";
import { BoardStore } from "./store.ts";
import type { ClientMsg, ServerMsg } from "./types.ts";
import { VersionTree } from "./versions.ts";

const MANUAL = new Set(["node:update", "node:create", "node:delete", "node:revert", "edge:add", "edge:update", "edge:reverse", "edge:delete", "node:restore"]);
const LAYOUT_ONLY = ["x", "y", "pinned", "open", "fold"];

/** 一块白板：内容、版本树、主对话 agent 和后台任务，彼此独立 */
export class Workspace {
  readonly store: BoardStore;
  readonly tasks: TaskRunner;
  readonly main: MainAgent;
  readonly versions: VersionTree;
  readonly sources: SourceLibrary;
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
    this.versions = new VersionTree(join(dir, "versions.json"), this.store);
  }

  async init() {
    await this.main.init();
    this.main.onSettled = (label) => this.versions.commit(label, this.main.messages);
    this.tasks.onFinished = (task) => {
      if (!this.main.busy) this.versions.commit(`任务：${task.title}`, this.main.messages);
    };
    if (!this.versions.head) this.versions.commit("起点", [], true);
    else {
      // 重新加载后恢复当前版本的 AI 对话上下文
      const head = this.versions.get(this.versions.head);
      if (head) this.main.restore(structuredClone(head.messages));
    }
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
    } finally {
      this.store.flush();
      this.versions.flush();
    }
  }

  dispose() {
    clearTimeout(this.manualTimer);
    this.main.dispose();
    this.tasks.dispose();
    this.store.close();
    this.versions.close();
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
    const layoutOnly = msg.type === "node:update" && Object.keys(msg.patch).every((k) => LAYOUT_ONLY.includes(k));
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
      case "edge:update":
        store.updateEdge(msg.id, msg.patch);
        break;
      case "edge:reverse":
        store.reverseEdge(msg.id);
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
        clearTimeout(this.manualTimer);
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
}
