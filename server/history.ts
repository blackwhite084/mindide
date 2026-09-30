import type { BoardStore } from "./store.ts";
import type { Board, ServerMsg } from "./types.ts";

type Content = Pick<Board, "nodes" | "edges" | "groups">;

const CHANGES = new Set<ServerMsg["type"]>([
  "node:upsert",
  "node:edit",
  "node:delete",
  "edge:add",
  "edge:delete",
  "group:upsert",
  "group:delete",
  "board:replace",
]);
/** 连续的改动（拖动、AI 连续调用工具）停下这么久后才算一步 */
const SETTLE_MS = 800;
const LIMIT = 50;

/**
 * 白板的撤销/重做：以快照为单位，不区分改动来自手动还是 AI。
 * 每批改动开始时把改动前的稳定快照压栈；对话记录不在其中。
 */
export class BoardHistory {
  private undoStack: Content[] = [];
  private redoStack: Content[] = [];
  /** 最近一次停下来时的白板内容 */
  private stable: Content;
  private batch = false;
  private timer: NodeJS.Timeout | undefined;
  private muted = 0;

  constructor(private store: BoardStore) {
    this.stable = this.capture();
    store.onMessage((msg) => {
      if (!CHANGES.has(msg.type)) return;
      if (!this.muted && !this.batch) {
        this.batch = true;
        this.undoStack.push(this.stable);
        if (this.undoStack.length > LIMIT) this.undoStack.shift();
        this.redoStack = [];
        this.broadcast();
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.settle(), SETTLE_MS);
    });
  }

  /** 这期间的改动不单独算一步（例如展开/折叠），但会并入之后的快照 */
  quiet(fn: () => void) {
    this.muted++;
    try {
      fn();
    } finally {
      this.muted--;
    }
  }

  undo() {
    this.step(this.undoStack, this.redoStack);
  }

  redo() {
    this.step(this.redoStack, this.undoStack);
  }

  /** 整体换了内容（切换版本等）后，之前的步骤不再适用 */
  clear() {
    this.settle();
    this.undoStack = [];
    this.redoStack = [];
    this.broadcast();
  }

  msg(): ServerMsg {
    return { type: "history", undo: this.undoStack.length, redo: this.redoStack.length };
  }

  dispose() {
    clearTimeout(this.timer);
  }

  private step(from: Content[], to: Content[]) {
    this.settle();
    const target = from.pop();
    if (!target) return;
    to.push(this.capture());
    const { board } = this.store;
    // 展开/折叠属于浏览状态，保持当前的样子
    const view = new Map(board.nodes.map((n) => [n.id, { open: n.open, fold: n.fold }]));
    const groupFold = new Map(board.groups.map((g) => [g.id, g.fold]));
    const nodes = structuredClone(target.nodes).map((n) => ({ ...n, ...view.get(n.id) }));
    const groups = structuredClone(target.groups).map((g) => ({ ...g, fold: groupFold.get(g.id) ?? g.fold }));
    this.quiet(() => this.store.replaceBoard({ nodes, edges: structuredClone(target.edges), groups, chat: board.chat }));
    this.stable = this.capture();
    this.broadcast();
  }

  private settle() {
    clearTimeout(this.timer);
    this.batch = false;
    this.stable = this.capture();
  }

  private capture(): Content {
    const { nodes, edges, groups } = this.store.board;
    // AI 正在生成的草稿节点不进快照
    return structuredClone({ nodes: nodes.filter((n) => !n.draft), edges, groups });
  }

  private broadcast() {
    this.store.emit(this.msg());
  }
}
