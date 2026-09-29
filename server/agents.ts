import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { firstLine, type BoardStore } from "./store.ts";
import { DraftTracker } from "./drafts.ts";
import { createCanvasTools, type ToolContext } from "./tools.ts";
import type { Activity, BoardNode, Task, TaskKind } from "./types.ts";
import { WEB_TOOLS } from "./web.ts";

const CANVAS_RULES = `白板是一棵（或几棵）思维树，面向内容而不是对话：
- 一个节点只讲一个要点：标题 ≤ 16 字，summary 是一句话要点（≤ 40 字），md 是可展开的细节。
- 用层级表达结构：主题 → 分支 → 细节。复杂内容拆成父节点 + 子节点，不要把一大篇塞进一个节点。
- 修改已有内容时用 canvas_edit_node 的 edits 做小范围替换，让用户看清改了哪里；需要调整层级时用 canvas_move_node。
- 节点之间的关系用 canvas_link，并写上简短的关系文字（如「导致」「依赖」「反例」），双向关系可以给两个方向写不同的文字。
- 兄弟节点之间如果其实是「前提 → 展开」「总 → 分」的关系，用 canvas_move_node 形成上下层级，而不是连线。
- 新建前先看白板索引，避免重复，已有的节点就在原处补充或修改。`;

const MAIN_PROMPT = `你是「思考板」里的 AI 搭档，和用户一起高频快速地思考、迭代。

${CANVAS_RULES}

工作方式：
- 有实质内容（概念、结论、方案、清单、对比……）就写进白板节点，而不是写在回复里。
- 你的文字回复显示在侧边的对话记录中，只用一两句话说明你做了什么、或回答简单的问题。
- 用户选中的节点是当前关注点，新内容默认挂在它下面。
- 需要最新信息或核实事实时，用 web_search 联网搜索（必要时 web_fetch 读原文），把来源链接写进节点正文。
- 耗时较长的调研或大规模整理，用 dispatch_task 派给后台 agent。
- 用中文，直接、紧凑。用户可能在你工作时继续追加或插入消息，请自然衔接。`;

const TASK_PROMPTS: Record<TaskKind, string> = {
  research: `你是后台调研 agent。根据任务说明联网搜索（web_search，必要时 web_fetch 读原文），多角度收集信息。
最终回答是一份中文 Markdown 报告，会作为节点放进白板：第一行用一句话写核心结论（纯文本，不加标题符号），之后分节列要点，最后附来源链接。
可以用 canvas_read 读取相关节点作为背景。`,
  organize: `你是后台整理 agent，负责整理白板内容。

${CANVAS_RULES}

先用 canvas_list / canvas_read 了解现状，再用工具归纳、合并、拆分、调整层级。完成后用两三句话总结你做了什么。`,
};

let runtimePromise: Promise<ModelRuntime> | undefined;
const getRuntime = () => (runtimePromise ??= ModelRuntime.create());

async function makeSession(systemPrompt: string, ctx: ToolContext, withWeb: boolean) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const customTools = [...createCanvasTools(ctx), ...(withWeb ? WEB_TOOLS : [])];
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime: await getRuntime(),
    resourceLoader: loader,
    customTools,
    tools: customTools.map((t) => t.name),
  });
  return session;
}

function activityOf(store: BoardStore, id: string, tool: string, args: any): Activity {
  const name = (nodeId?: string) => {
    const n = nodeId ? store.resolve(nodeId) : undefined;
    return n ? `「${n.title || firstLine(n.md, 16)}」` : "";
  };
  let label: string = tool;
  let nodeId: string | undefined;
  switch (tool) {
    case "web_search":
      label = `搜索：${args?.query ?? ""}`;
      break;
    case "web_fetch":
      label = `读取网页：${(args?.urls ?? []).map((u: string) => u.replace(/^https?:\/\//, "")).join(", ")}`;
      break;
    case "canvas_list":
      label = "查看白板";
      break;
    case "canvas_read":
      label = `读取 ${(args?.ids ?? []).map((i: string) => name(i) || i).join("")}`;
      nodeId = args?.ids?.[0];
      break;
    case "canvas_create_node":
      label = `新建「${args?.title ?? ""}」`;
      break;
    case "canvas_edit_node":
      label = `修改 ${name(args?.id)}`;
      nodeId = args?.id;
      break;
    case "canvas_move_node":
      label = `调整 ${name(args?.id)} 的位置`;
      nodeId = args?.id;
      break;
    case "canvas_delete_node":
      label = `删除 ${name(args?.id)}`;
      break;
    case "canvas_link": {
      const arrow = args?.bidirectional || args?.reverseLabel ? "↔" : "→";
      label = `关系 ${name(args?.source)} ${arrow} ${name(args?.target)}${args?.label ? `：${args.label}` : ""}`;
      nodeId = args?.target;
      break;
    }
    case "canvas_unlink":
      label = `删除关系 ${name(args?.source)} — ${name(args?.target)}`;
      break;
    case "dispatch_task":
      label = `派发任务「${args?.title ?? ""}」`;
      break;
  }
  const resolved = nodeId ? store.resolve(nodeId)?.id : undefined;
  return { id, tool, label, status: "running", nodeId: resolved };
}

function resultText(result: any, max = 600): string {
  const s = (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function messageText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  return (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
}

function finishActivity(list: Activity[], e: { toolCallId: string; isError: boolean; result: any }) {
  return list.map((a) =>
    a.id === e.toolCallId
      ? {
          ...a,
          status: e.isError ? ("error" as const) : ("done" as const),
          detail: resultText(e.result),
          nodeId: e.result?.details?.nodeId ?? a.nodeId,
        }
      : a,
  );
}

function upsertActivity(list: Activity[], a: Activity): Activity[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i < 0) return [...list, a];
  const prev = list[i];
  if (prev.label === a.label && prev.nodeId === a.nodeId && prev.status === a.status) return list;
  return list.map((x, j) => (j === i ? { ...prev, ...a } : x));
}

/** 从流式事件里取出正在生成的工具调用 */
function streamingToolCall(e: any): { id: string; name: string; arguments?: any } | undefined {
  const a = e.assistantMessageEvent;
  if (a?.type === "toolcall_end") return a.toolCall;
  if (a?.type !== "toolcall_start" && a?.type !== "toolcall_delta") return;
  const tc = a.partial?.content?.[a.contentIndex];
  return tc?.type === "toolCall" && tc.name ? tc : undefined;
}

interface Pending {
  text: string;
  contextNodeIds: string[];
}

/** 主对话：内容写到白板，对话过程写到对话记录 */
export class MainAgent {
  private session!: AgentSession;
  /** 已发送但尚未被模型接收的消息：完整 prompt → 原始输入 */
  private pending = new Map<string, Pending>();
  private focus: string[] = [];
  private aiEntry: string | undefined;
  private runLabel: string | undefined;
  private suppressSettle = false;
  private drafts!: DraftTracker;
  busy = false;
  /** 一轮对话彻底结束时回调（用于记录版本） */
  onSettled: ((label: string) => void) | undefined;

  constructor(
    private store: BoardStore,
    private tasks: TaskRunner,
  ) {}

  async init() {
    const defaultParent = () => this.focus.find((id) => this.store.get(id)) ?? null;
    this.drafts = new DraftTracker(this.store, defaultParent);
    const ctx: ToolContext = {
      store: this.store,
      by: "AI",
      defaultParent,
      claimDraft: (id) => this.drafts.claim(id),
      dispatch: (kind, title, instructions, ids) => this.tasks.run(kind, title, instructions, ids.length ? ids : this.focus),
    };
    this.session = await makeSession(MAIN_PROMPT, ctx, true);
    this.session.subscribe((e) => this.onEvent(e));
    const m = this.session.model;
    console.log(`[main] model ${m?.provider}/${m?.id}`);
  }

  queueState() {
    const show = (arr: readonly string[]) => arr.map((p) => this.pending.get(p)?.text ?? p);
    return {
      steering: show(this.session.getSteeringMessages()),
      followUp: show(this.session.getFollowUpMessages()),
    };
  }

  chat(text: string, mode: "queue" | "steer", contextNodeIds: string[]) {
    const prompt = this.composePrompt(text, contextNodeIds);
    this.pending.set(prompt, { text, contextNodeIds });
    const run = this.session.isStreaming
      ? this.session.prompt(prompt, { streamingBehavior: mode === "steer" ? "steer" : "followUp" })
      : this.session.prompt(prompt);
    run.catch((err) => this.store.emit({ type: "error", message: String(err?.message ?? err) }));
  }

  private composePrompt(text: string, contextNodeIds: string[]) {
    const parts = [`[白板索引]\n${this.store.outline()}`];
    const selected = contextNodeIds.map((id) => this.store.get(id)).filter(Boolean) as BoardNode[];
    if (selected.length) {
      parts.push(
        "[用户选中的节点]\n" +
          selected.map((n) => `<node id="${n.id}" title="${n.title}" summary="${n.summary}">\n${n.md}\n</node>`).join("\n"),
      );
    }
    parts.push(`[用户消息]\n${text}`);
    return parts.join("\n\n");
  }

  abort() {
    this.session.abort();
  }

  get messages(): unknown[] {
    return this.session.messages;
  }

  clearQueue() {
    const { steering, followUp } = this.session.clearQueue();
    for (const p of [...steering, ...followUp]) this.pending.delete(p);
    this.store.emit({ type: "queue", queue: this.queueState() });
  }

  /** 停止当前回答并清空队列，期间不触发版本记录 */
  async stop() {
    this.suppressSettle = true;
    try {
      this.clearQueue();
      if (this.session.isStreaming) await this.session.abort();
      await this.session.agent.waitForIdle();
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      this.suppressSettle = false;
    }
    this.finishAi();
    this.setBusy(false);
  }

  /** 回到某个版本：恢复当时的对话上下文 */
  restore(messages: unknown[]) {
    this.pending.clear();
    this.session.agent.state.messages = messages as any;
    this.focus = [];
    this.aiEntry = undefined;
    this.runLabel = undefined;
    this.store.emit({ type: "queue", queue: this.queueState() });
  }

  private ensureAi(): string {
    if (this.aiEntry && this.store.getChat(this.aiEntry)) return this.aiEntry;
    this.aiEntry = this.store.addChat({ role: "ai", text: "", activity: [], streaming: true }).id;
    return this.aiEntry;
  }

  private finishAi() {
    if (this.aiEntry) this.store.updateChat(this.aiEntry, { streaming: false });
  }

  private onEvent(e: AgentSessionEvent) {
    switch (e.type) {
      case "agent_start":
        this.setBusy(true);
        break;
      case "agent_settled":
        this.drafts.cleanup();
        this.finishAi();
        this.aiEntry = undefined;
        this.setBusy(false);
        if (!this.suppressSettle) this.onSettled?.(this.runLabel ?? "对话");
        this.runLabel = undefined;
        break;
      case "queue_update":
        this.store.emit({ type: "queue", queue: this.queueState() });
        break;
      case "message_start": {
        if (e.message.role !== "user") break;
        const prompt = messageText(e.message);
        const p = this.pending.get(prompt);
        this.pending.delete(prompt);
        const text = p?.text ?? prompt;
        this.finishAi();
        this.aiEntry = undefined;
        this.focus = p?.contextNodeIds ?? [];
        this.runLabel ??= firstLine(text, 30);
        this.store.addChat({ role: "user", text, contextNodeIds: this.focus });
        break;
      }
      case "message_update": {
        if (e.assistantMessageEvent.type === "text_delta") {
          this.store.appendChat(this.ensureAi(), e.assistantMessageEvent.delta);
          break;
        }
        // 工具调用还在生成时就给出反馈：草稿节点 + 对话里的进行中操作
        const tc = streamingToolCall(e);
        if (!tc) break;
        this.drafts.update(tc, e.assistantMessageEvent.type === "toolcall_end");
        const id = this.ensureAi();
        const entry = this.store.getChat(id)!;
        const next = upsertActivity(entry.activity ?? [], activityOf(this.store, tc.id, tc.name, tc.arguments));
        if (next !== entry.activity) this.store.updateChat(id, { activity: next });
        break;
      }
      case "message_end":
        if (e.message.role === "assistant" && (e.message as any).stopReason !== "toolUse") this.drafts.cleanup();
        if (e.message.role === "assistant" && (e.message as any).stopReason === "error") {
          this.store.emit({ type: "error", message: (e.message as any).errorMessage ?? "模型出错" });
        }
        break;
      case "tool_execution_start": {
        const id = this.ensureAi();
        const entry = this.store.getChat(id)!;
        this.store.updateChat(id, {
          activity: upsertActivity(entry.activity ?? [], activityOf(this.store, e.toolCallId, e.toolName, e.args)),
        });
        break;
      }
      case "tool_execution_end": {
        const entry = this.aiEntry ? this.store.getChat(this.aiEntry) : undefined;
        if (entry) this.store.updateChat(entry.id, { activity: finishActivity(entry.activity ?? [], e) });
        break;
      }
    }
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.store.emit({ type: "busy", busy });
  }
}

/** 调度板：每个任务一个独立的 pi 会话 */
export class TaskRunner {
  private sessions = new Map<string, AgentSession>();
  onFinished: ((task: Task) => void) | undefined;

  constructor(private store: BoardStore) {}

  run(kind: TaskKind, title: string, instructions: string, contextNodeIds: string[]): string {
    const task: Task = {
      id: nanoid(6),
      kind,
      title: title || firstLine(instructions, 24),
      instructions,
      contextNodeIds,
      status: "running",
      log: "",
      activity: [],
      createdAt: Date.now(),
    };
    this.store.upsertTask(task);
    this.start(task).catch((err) => {
      task.log += `\n\n[错误] ${err?.message ?? err}`;
      task.status = "error";
      this.store.upsertTask(task);
    });
    return task.id;
  }

  private async start(task: Task) {
    const anchor = task.contextNodeIds.find((id) => this.store.get(id)) ?? null;
    const drafts = new DraftTracker(this.store, () => anchor);
    const ctx: ToolContext = {
      store: this.store,
      by: `任务「${task.title}」`,
      defaultParent: () => anchor,
      claimDraft: (id) => drafts.claim(id),
    };
    const session = await makeSession(TASK_PROMPTS[task.kind], ctx, task.kind === "research");
    this.sessions.set(task.id, session);

    let lastText = "";
    session.subscribe((e) => {
      switch (e.type) {
        case "message_start":
          if (e.message.role === "assistant") lastText = "";
          break;
        case "message_update": {
          if (e.assistantMessageEvent.type === "text_delta") {
            lastText += e.assistantMessageEvent.delta;
            task.log += e.assistantMessageEvent.delta;
            this.store.emit({ type: "task:delta", id: task.id, delta: e.assistantMessageEvent.delta });
            break;
          }
          const tc = streamingToolCall(e);
          if (!tc) break;
          drafts.update(tc, e.assistantMessageEvent.type === "toolcall_end");
          const next = upsertActivity(task.activity, activityOf(this.store, tc.id, tc.name, tc.arguments));
          if (next !== task.activity) {
            task.activity = next;
            this.store.upsertTask(task);
          }
          break;
        }
        case "tool_execution_start":
          task.activity = upsertActivity(task.activity, activityOf(this.store, e.toolCallId, e.toolName, e.args));
          task.log += "\n\n";
          this.store.upsertTask(task);
          break;
        case "tool_execution_end":
          task.activity = finishActivity(task.activity, e);
          this.store.upsertTask(task);
          break;
      }
    });

    const ctxText = task.contextNodeIds
      .map((id) => this.store.get(id))
      .filter(Boolean)
      .map((n) => `<node id="${n!.id}" title="${n!.title}">\n${n!.md}\n</node>`)
      .join("\n");
    const prompt = `[任务] ${task.title}\n\n${task.instructions}${ctxText ? `\n\n[相关节点]\n${ctxText}` : ""}\n\n[白板索引]\n${this.store.outline()}`;

    await session.prompt(prompt);
    await session.agent.waitForIdle();
    drafts.cleanup();
    if (task.status === "aborted") return;

    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage && !lastText) {
      task.status = "error";
      task.log += `\n\n[错误] ${errorMessage}`;
    } else {
      task.status = "done";
      const report = lastText.trim();
      if (task.kind === "research" && report) {
        const [head, ...rest] = report.split("\n");
        const node = this.store.createNode(
          {
            kind: "task",
            title: task.title,
            summary: firstLine(head, 60),
            md: rest.join("\n").trim() || report,
            parentId: anchor,
          },
          true,
        );
        task.resultNodeId = node.id;
      }
    }
    this.store.upsertTask(task);
    this.onFinished?.(task);
  }

  steer(id: string, text: string) {
    const session = this.sessions.get(id);
    const task = this.store.tasks.get(id);
    if (!session || !task) return;
    task.log += `\n\n> 👤 ${text}\n\n`;
    this.store.upsertTask(task);
    if (session.isStreaming) session.steer(text);
    else {
      task.status = "running";
      this.store.upsertTask(task);
      session.prompt(text).then(() => {
        task.status = "done";
        this.store.upsertTask(task);
      });
    }
  }

  abort(id: string) {
    const task = this.store.tasks.get(id);
    if (!task) return;
    task.status = "aborted";
    this.store.upsertTask(task);
    this.sessions.get(id)?.abort();
  }
}
