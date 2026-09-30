import { diffWords } from "diff";

/**
 * 节点编辑动画：把 before → after 拆成若干改动块（hunk），
 * 串行播放：定位节点 → 标出要删的部分 → 逐字删掉 → 逐字打出新内容 → 高亮渐隐。
 * 修改动画全局只有一个播放队列，保证同一时刻只有一个节点在动；
 * 积压时同一节点排队中的修改会合并成一次播放（正文和摘要同时播）。
 * 新建节点只是轻量地打出摘要，可以并行，不占用修改队列。
 */

export type SegKind = "eq" | "del" | "ins";
export type Field = "md" | "summary";

export interface Seg {
  kind: SegKind;
  text: string;
  /** del：剩余可见字符数；ins：已打出的字符数 */
  shown: number;
  state: "idle" | "mark" | "active" | "done";
}

export interface Frame {
  segs: Seg[];
  phase: "enter" | "play" | "settle" | "fade";
  by: string;
  mode: "create" | "edit";
  field: Field;
  activeIndex: number;
}

interface Change {
  before: string;
  after: string;
}

interface Job {
  nodeId: string;
  changes: Partial<Record<Field, Change>>;
  by: string;
  mode: "create" | "edit";
}

const frameKey = (nodeId: string, field: Field) => `${nodeId}:${field}`;

class Cancelled extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
  p ? Promise.race([p.catch(() => {}), sleep(ms)]) : Promise.resolve();

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("zh", { granularity: "word" }) : undefined;

export function computeSegs(before: string, after: string): Seg[] {
  const parts = diffWords(before, after, segmenter ? { intlSegmenter: segmenter } : undefined);
  return parts.map((p) => {
    const kind: SegKind = p.added ? "ins" : p.removed ? "del" : "eq";
    return { kind, text: p.value, shown: kind === "ins" ? 0 : p.value.length, state: "idle" };
  });
}

class Animator {
  private queue: Job[] = [];
  private running = false;
  private frames = new Map<string, Frame>();
  private listeners = new Set<() => void>();
  private generation = 0;
  /** 播放前把镜头移到节点（由画布注册） */
  focus: ((nodeId: string) => Promise<void>) | undefined;
  speed = 1;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  frame = (nodeId: string, field: Field) => this.frames.get(frameKey(nodeId, field));

  /** 节点有排队中但未开始的修改时，返回应当先展示的旧内容 */
  pendingBefore(nodeId: string, field: Field): string | undefined {
    return this.queue.find((j) => j.nodeId === nodeId && j.changes[field])?.changes[field]!.before;
  }

  /** 切换版本时丢弃所有动画 */
  reset() {
    this.queue = [];
    this.frames.clear();
    this.generation++;
    this.notify();
  }

  enqueue(nodeId: string, field: Field, before: string, after: string, by: string, mode: "create" | "edit" = "edit") {
    if (before === after) return;
    if (mode === "create") {
      this.play({ nodeId, changes: { [field]: { before, after } }, by, mode }).catch(() => {});
      return;
    }
    // 同一节点还没开始播的修改：合并成一次，从最早的旧内容直接播到最新内容
    const queued = this.queue.find((j) => j.nodeId === nodeId);
    if (queued) {
      const prev = queued.changes[field];
      if (!prev) queued.changes[field] = { before, after };
      else if (prev.before === after) delete queued.changes[field];
      else prev.after = after;
      queued.by = by;
      if (!queued.changes.md && !queued.changes.summary) this.queue.splice(this.queue.indexOf(queued), 1);
    } else {
      this.queue.push({ nodeId, changes: { [field]: { before, after } }, by, mode });
    }
    this.notify();
    if (!this.running) this.run();
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private setFrame(key: string, f: Frame | undefined, gen: number) {
    if (gen !== this.generation) throw new Cancelled();
    if (f) this.frames.set(key, { ...f, segs: f.segs.map((s) => ({ ...s })) });
    else this.frames.delete(key);
    this.notify();
  }

  private async run() {
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      try {
        await this.play(job);
      } catch (err) {
        if (!(err instanceof Cancelled)) {
          console.error(err);
          for (const field of Object.keys(job.changes) as Field[]) this.frames.delete(frameKey(job.nodeId, field));
          this.notify();
        }
      }
    }
    this.running = false;
  }

  private async play({ nodeId, changes, by, mode }: Job) {
    const create = mode === "create";
    const gen = this.generation;
    const fields = (Object.keys(changes) as Field[]).map((field) => {
      const { before, after } = changes[field]!;
      const frame: Frame = { segs: computeSegs(before, after), phase: "enter", by, mode, field, activeIndex: -1 };
      const push = () => this.setFrame(frameKey(nodeId, field), frame, gen);
      push();
      return { frame, push };
    });
    if (create) {
      // 新建不抢镜头：只有没有修改在播放时才顺带移过去
      if (!this.running) this.focus?.(nodeId);
    } else {
      await withTimeout(this.focus?.(nodeId), 700);
      await sleep(220 / this.speed);
    }
    // 正文和摘要同时播
    await Promise.all(fields.map(({ frame, push }) => this.playFrame(frame, push)));
    for (const f of fields) f.frame.phase = "settle";
    for (const f of fields) f.push();
    await sleep((create ? 250 : 900) / this.speed);
    for (const f of fields) f.frame.phase = "fade";
    for (const f of fields) f.push();
    await sleep((create ? 450 : 700) / this.speed);
    for (const field of Object.keys(changes) as Field[]) this.setFrame(frameKey(nodeId, field), undefined, gen);
  }

  private async playFrame(frame: Frame, push: () => void) {
    const create = frame.mode === "create";
    const { segs } = frame;

    // 把相邻的 del/ins 合成一个改动块
    const hunks: number[][] = [];
    segs.forEach((s, i) => {
      if (s.kind === "eq") return;
      const last = hunks.at(-1);
      if (last && last.at(-1) === i - 1) last.push(i);
      else hunks.push([i]);
    });

    const changed = segs.reduce((n, s) => n + (s.kind === "eq" ? 0 : s.text.length), 0);
    const budget = create ? 700 : 2600;
    const msPerChar = Math.min(create ? 18 : 32, Math.max(4, budget / Math.max(changed, 1))) / this.speed;
    const huge = changed > 4000;
    frame.phase = "play";

    for (const hunk of hunks) {
      const dels = hunk.filter((i) => segs[i].kind === "del");
      const inss = hunk.filter((i) => segs[i].kind === "ins");
      frame.activeIndex = hunk[0];

      if (dels.length) {
        // 先标红，让人看清“要删的是哪里”
        for (const i of dels) segs[i].state = "mark";
        push();
        await sleep(380 / this.speed);
        for (const i of dels) {
          segs[i].state = "active";
          await this.tick(segs[i], "del", huge ? 0 : msPerChar * 0.6, push);
          segs[i].state = "done";
        }
        push();
      }
      for (const i of inss) {
        segs[i].state = "active";
        frame.activeIndex = i;
        await this.tick(segs[i], "ins", huge ? 0 : msPerChar, push);
        segs[i].state = "done";
      }
      push();
      if (!create) await sleep(140 / this.speed);
    }

    frame.activeIndex = -1;
  }

  private async tick(seg: Seg, mode: "del" | "ins", msPerChar: number, push: () => void) {
    const chars = [...seg.text];
    if (msPerChar <= 0) {
      seg.shown = mode === "ins" ? seg.text.length : 0;
      push();
      return;
    }
    const step = Math.max(1, Math.round(16 / msPerChar));
    let n = mode === "ins" ? 0 : chars.length;
    while (mode === "ins" ? n < chars.length : n > 0) {
      n = mode === "ins" ? Math.min(chars.length, n + step) : Math.max(0, n - step);
      seg.shown = chars.slice(0, n).join("").length;
      push();
      await sleep(Math.max(16, msPerChar * step));
    }
  }
}

export const animator = new Animator();
