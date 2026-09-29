import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { firstLine } from "./store.ts";
import type { ChatEntry, ConversationMeta } from "./types.ts";

interface Conversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 对话记录（显示用） */
  chat: ChatEntry[];
  /** 主 agent 的对话上下文 */
  messages: unknown[];
}

/**
 * 一块白板上的多个对话。当前对话的实时内容在 board.chat 和主 agent 里，
 * 这里存的是它们的副本，切换、结束一轮对话、退出时同步。
 */
export class ConversationStore {
  private list: Conversation[] = [];
  current: string | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private file: string) {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      this.list = data.list ?? [];
      this.current = data.current ?? null;
    }
  }

  get(id: string) {
    return this.list.find((c) => c.id === id);
  }

  metas(): ConversationMeta[] {
    return [...this.list]
      .filter((c) => c.chat.length || c.id === this.current)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        id: c.id,
        title: titleOf(c.chat),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        count: c.chat.filter((e) => e.role === "user").length,
      }));
  }

  create(id = nanoid(8), chat: ChatEntry[] = [], messages: unknown[] = []) {
    const now = Date.now();
    const c: Conversation = { id, createdAt: now, updatedAt: chat.at(-1)?.at ?? now, chat, messages };
    this.list = this.list.filter((x) => x.id !== id);
    this.list.push(c);
    this.current = id;
    this.persist();
    return c;
  }

  /** 把当前对话的最新内容存下来 */
  sync(chat: ChatEntry[], messages: unknown[]) {
    const c = this.current ? this.get(this.current) : undefined;
    if (!c) return;
    c.chat = structuredClone(chat.map((e) => (e.streaming ? { ...e, streaming: false } : e)));
    c.messages = structuredClone(messages);
    c.updatedAt = chat.at(-1)?.at ?? c.updatedAt;
    this.persist();
  }

  /** 切到某个对话；不存在则新建（例如回到的版本属于已删除的对话） */
  activate(id: string, chat?: ChatEntry[], messages?: unknown[]) {
    this.dropEmpty(id);
    const c = this.get(id) ?? this.create(id);
    if (chat) c.chat = chat;
    if (messages) c.messages = messages;
    this.current = id;
    this.persist();
    return c;
  }

  remove(id: string) {
    this.list = this.list.filter((c) => c.id !== id);
    this.persist();
  }

  /** 离开一个空对话时不留下记录 */
  dropEmpty(except: string) {
    this.list = this.list.filter((c) => c.id === except || c.chat.length > 0);
  }

  close() {
    this.closed = true;
    clearTimeout(this.saveTimer);
  }

  private persist() {
    if (this.closed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    if (this.closed) return;
    clearTimeout(this.saveTimer);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ current: this.current, list: this.list }));
  }
}

export function titleOf(chat: ChatEntry[]) {
  const first = chat.find((e) => e.role === "user");
  return first ? firstLine(first.text, 30) || "新对话" : "新对话";
}
