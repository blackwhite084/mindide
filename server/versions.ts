import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { BoardStore } from "./store.ts";
import type { Board, VersionMeta } from "./types.ts";

interface Version extends VersionMeta {
  board: Board;
  /** 主 agent 当时的对话上下文，回到该版本时一并恢复 */
  messages: unknown[];
}

/**
 * 版本树：每个版本是白板 + AI 对话上下文的完整快照。
 * 回到旧版本后继续操作，新版本的 parent 就是那个旧版本，自然形成分支。
 */
export class VersionTree {
  private versions: Version[] = [];
  head: string | null = null;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private file: string,
    private store: BoardStore,
  ) {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      this.versions = data.versions ?? [];
      this.head = data.head ?? null;
    }
  }

  get(id: string) {
    return this.versions.find((v) => v.id === id);
  }

  metas(): VersionMeta[] {
    return this.versions.map(({ board: _b, messages: _m, ...meta }) => meta);
  }

  broadcast() {
    this.store.emit({ type: "versions", versions: this.metas(), head: this.head });
  }

  /** 白板和上一个版本相比有变化时才记录 */
  commit(label: string, messages: unknown[], force = false) {
    const board = structuredClone(this.store.board);
    board.nodes = board.nodes.filter((n) => !n.draft);
    const prev = this.head ? this.get(this.head) : undefined;
    if (!force && prev && sameBoard(prev.board, board)) {
      // 白板没变、只有对话变化时，更新当前版本的对话即可
      prev.messages = structuredClone(messages);
      prev.board.chat = board.chat;
      this.persist();
      return prev;
    }
    const v: Version = {
      id: nanoid(8),
      parentId: this.head,
      label,
      at: Date.now(),
      nodeCount: board.nodes.length,
      board,
      messages: structuredClone(messages),
    };
    this.versions.push(v);
    this.head = v.id;
    this.persist();
    this.broadcast();
    return v;
  }

  checkout(id: string) {
    const v = this.get(id);
    if (!v) return;
    this.head = id;
    this.persist();
    this.broadcast();
    return { board: structuredClone(v.board), messages: structuredClone(v.messages) };
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ head: this.head, versions: this.versions }));
    }, 500);
  }
}

function sameBoard(a: Board, b: Board) {
  // 只移动位置不算新版本，但新版本会带上最新布局
  const key = (x: Board) =>
    JSON.stringify({
      n: x.nodes.map((n) => [n.id, n.title, n.summary, n.md, n.parentId]),
      e: x.edges.map((e) => [e.source, e.target, e.dir, e.label, e.reverseLabel]),
    });
  return key(a) === key(b);
}
