import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { DATA_DIR } from "./paths.ts";
import { firstLine } from "./store.ts";
import type { BoardMeta } from "./types.ts";
import { Workspace } from "./workspace.ts";

export const DEFAULT_NAME = "未命名白板";

interface Index {
  boards: Omit<BoardMeta, "nodeCount">[];
  current: string;
  counts?: Record<string, number>;
}

/** 多白板：data/boards/<id>/ 下各自保存内容与版本，按需加载 */
export class BoardManager {
  private index: Index;
  private open = new Map<string, Promise<Workspace>>();
  private loaded = new Map<string, Workspace>();
  private file: string;
  onChange: (() => void) | undefined;

  constructor(private dataDir = DATA_DIR) {
    this.file = join(dataDir, "boards.json");
    mkdirSync(join(dataDir, "boards"), { recursive: true });
    if (existsSync(this.file)) {
      this.index = JSON.parse(readFileSync(this.file, "utf8"));
    } else {
      this.index = { boards: [], current: "" };
      this.migrate();
    }
    if (!this.index.boards.length) this.create(DEFAULT_NAME, false);
    if (!this.index.boards.some((b) => b.id === this.index.current)) this.index.current = this.index.boards[0].id;
    this.save();
  }

  /** 旧版单白板数据（data/board.json）迁移为第一块白板 */
  private migrate() {
    const old = join(this.dataDir, "board.json");
    if (!existsSync(old)) return;
    const meta = this.create(guessName(old), false);
    const dir = this.dir(meta.id);
    renameSync(old, join(dir, "board.json"));
    const versions = join(this.dataDir, "versions.json");
    if (existsSync(versions)) renameSync(versions, join(dir, "versions.json"));
    console.log(`[boards] 已迁移旧数据到白板「${meta.name}」`);
  }

  private dir(id: string) {
    return join(this.dataDir, "boards", id);
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.index, null, 2));
  }

  get current() {
    return this.index.current;
  }

  list(): BoardMeta[] {
    return this.index.boards
      .map((b) => ({ ...b, nodeCount: this.loaded.get(b.id)?.nodeCount ?? this.index.counts?.[b.id] ?? 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  has(id: string) {
    return this.index.boards.some((b) => b.id === id);
  }

  async get(id: string): Promise<Workspace> {
    let p = this.open.get(id);
    if (!p) {
      mkdirSync(this.dir(id), { recursive: true });
      const ws = new Workspace(id, this.dir(id));
      p = ws.init().then(() => {
        this.loaded.set(id, ws);
        this.watch(ws);
        return ws;
      });
      this.open.set(id, p);
    }
    return p;
  }

  /** 内容变化时更新时间与节点数；未命名的白板用第一个主题的标题命名 */
  private watch(ws: Workspace) {
    let timer: NodeJS.Timeout | undefined;
    ws.store.onMessage((msg) => {
      if (msg.type === "queue" || msg.type === "busy" || msg.type === "versions" || msg.type === "history") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const meta = this.index.boards.find((b) => b.id === ws.id);
        if (!meta) return;
        meta.updatedAt = Date.now();
        this.index.counts = { ...this.index.counts, [ws.id]: ws.nodeCount };
        const root = ws.store.board.nodes.find((n) => !n.parentId && !n.draft && n.title);
        if (meta.name === DEFAULT_NAME && root) meta.name = root.title.slice(0, 30);
        this.save();
        this.onChange?.();
      }, 800);
    });
  }

  switchTo(id: string) {
    if (!this.has(id)) return;
    this.index.current = id;
    this.save();
  }

  create(name: string, notify = true): BoardMeta {
    const now = Date.now();
    const meta = { id: nanoid(8), name: name.trim() || DEFAULT_NAME, createdAt: now, updatedAt: now };
    mkdirSync(this.dir(meta.id), { recursive: true });
    this.index.boards.push(meta);
    this.save();
    if (notify) this.onChange?.();
    return { ...meta, nodeCount: 0 };
  }

  rename(id: string, name: string) {
    const meta = this.index.boards.find((b) => b.id === id);
    if (!meta || !name.trim()) return;
    meta.name = name.trim().slice(0, 40);
    this.save();
    this.onChange?.();
  }

  /** 删除白板；返回删除后应切换到的白板 id */
  async remove(id: string): Promise<string> {
    const ws = await this.open.get(id);
    ws?.dispose();
    this.open.delete(id);
    this.loaded.delete(id);
    this.index.boards = this.index.boards.filter((b) => b.id !== id);
    if (!this.index.boards.length) this.create(DEFAULT_NAME, false);
    if (this.index.current === id) this.index.current = this.list()[0].id;
    this.save();
    rmSync(this.dir(id), { recursive: true, force: true });
    this.onChange?.();
    return this.index.current;
  }

  /** 已加载的白板（切换模型时需要逐个更新） */
  workspaces() {
    return [...this.loaded.values()];
  }
}

function guessName(file: string) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const root = (data.board?.nodes ?? []).find((n: any) => !n.parentId && n.title);
    return root ? firstLine(root.title, 30) : "我的白板";
  } catch {
    return "我的白板";
  }
}
