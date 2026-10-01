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
import { settings } from "./settings.ts";
import { createSourceTools } from "./sourceTools.ts";
import type { SourceLibrary } from "./sources.ts";
import type { Activity, BoardNode, ModelInfo, Task, ThinkingLevel } from "./types.ts";
import { WEB_TOOLS } from "./web.ts";
import { findSkill, skillBlock, skillsPrompt, parseSkillCommand } from "./skills.ts";

const CANVAS_RULES = `白板是一棵（或几棵）思维树，面向内容而不是对话：
- 一个节点只讲一个要点：标题 ≤ 16 字，summary 是一句话要点（≤ 40 字），md 是可展开的细节。
- 用层级表达结构：主题 → 分支 → 细节。复杂内容拆成父节点 + 子节点，不要把一大篇塞进一个节点。
- 修改已有内容时用 canvas_edit_node 的 edits 做小范围替换，让用户看清改了哪里；需要调整层级时用 canvas_move_node。
- 节点之间的关系用 canvas_link，并写上简短的关系文字（如「导致」「依赖」「反例」），双向关系可以给两个方向写不同的文字。
- 兄弟节点之间如果其实是「前提 → 展开」「总 → 分」的关系，用 canvas_move_node 形成上下层级，而不是连线。
- 主题多了（大约 6 个以上）就用 canvas_group 把相关主题分成几个分组，给画面分区；次要的分组可以折叠。主题内部的归类仍然用父子节点，不要用分组。
- 新建前先看白板索引，避免重复，已有的节点就在原处补充或修改。
- 图表、SVG 插图、结构示意、交互演示、对白板内容的自定义可视化等文字说不清的内容，用 canvas_create_widget 做成组件节点；工具结果会告诉你运行是否报错，报错就修好。`;

const MAIN_PROMPT = `你是「思考板」里的 AI 搭档，和用户一起高频快速地思考、迭代。

${CANVAS_RULES}

工作方式：
- 有实质内容（概念、结论、方案、清单、对比……）就写进白板节点，而不是写在回复里。
- 你的文字回复显示在侧边的对话记录中，只用一两句话说明你做了什么、或回答简单的问题。
- 用户选中的节点是当前关注点，新内容默认挂在它下面。
- 需要最新信息或核实事实时，用 web_search 联网搜索（必要时 web_fetch 读原文），把来源链接写进节点正文。
- 耗时较长的深入调研或大规模整理，用 dispatch_task 派给后台 agent。
- 需求有歧义、有几个方向需要用户拍板时，用 ask_user 提问（可以一次问几个问题并给出候选项），拿到回答再动手；能合理假设的小事不要问。
- 用户提供了参考资料（文件、代码库目录）时，用 source_search 定位、source_read 阅读、source_tree 看目录结构，需要时用 source_bash 执行查看命令（如 git log、wc -l），结论写进节点并注明出处（文件名:行号 或 页码）。不要凭空猜测资料内容。
- 用中文，直接、紧凑。用户可能在你工作时继续追加或插入消息，请自然衔接。`;

const TASK_PROMPT = `你是后台 agent，在用户继续思考的同时独立完成一项任务（调研、整理、归纳……）。

${CANVAS_RULES}

- 先用 canvas_list / canvas_read 了解现状，再动手。
- 需要最新信息或核实事实时，用 web_search 联网搜索（必要时 web_fetch 读原文），把来源链接写进节点正文。
- 用户提供了参考资料时，用 source_search / source_read 查阅，并注明出处。
- 只有必须由用户决定的问题才用 ask_user 提问（用户可能不在跟前，提问会让任务停下来等待）。
- 成果直接用工具写进白板；最终回答只用两三句话总结你做了什么。`;

let runtimePromise: Promise<ModelRuntime> | undefined;
export const getRuntime = () => (runtimePromise ??= ModelRuntime.create());

/** 有认证可用的模型；带日期的快照版本在有别名时隐藏 */
export async function listModels(): Promise<ModelInfo[]> {
  const models = await (await getRuntime()).getAvailable();
  const keys = new Set(models.map((m) => `${m.provider}/${m.id}`));
  return models
    .filter((m) => {
      const alias = m.id.replace(/-\d{8}$/, "");
      return alias === m.id || !keys.has(`${m.provider}/${alias}`);
    })
    .map((m) => ({ key: `${m.provider}/${m.id}`, provider: m.provider, name: m.name || m.id, reasoning: !!m.reasoning }));
}

export async function resolveModel(key: string | undefined) {
  if (!key) return undefined;
  const i = key.indexOf("/");
  return (await getRuntime()).getModel(key.slice(0, i), key.slice(i + 1)) ?? undefined;
}

const thinkingFor = (model: { reasoning?: boolean } | undefined): ThinkingLevel =>
  model?.reasoning ? settings.thinking : "off";

async function makeSession(systemPrompt: () => string, ctx: ToolContext, sources?: SourceLibrary) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPrompt: systemPrompt(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const customTools = [
    ...createCanvasTools(ctx),
    ...WEB_TOOLS,
    ...(sources ? createSourceTools(sources) : []),
  ];
  const model = await resolveModel(settings.model);
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime: await getRuntime(),
    ...(model ? { model, thinkingLevel: thinkingFor(model) } : {}),
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
      // 流式生成时标题可能还没写出来
      label = args?.title ? `新建「${args.title}」` : "新建节点…";
      break;
    case "canvas_create_widget":
      label = args?.title ? `新建组件「${args.title}」` : "新建组件…";
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
    case "canvas_group":
      label = args?.groupId ? `更新分组${args?.title ? `「${args.title}」` : ""}` : args?.title ? `新建分组「${args.title}」` : "新建分组…";
      nodeId = args?.ids?.[0];
      break;
    case "canvas_ungroup":
      label = args?.ids?.length ? `移出分组 ${args.ids.map((i: string) => name(i)).join("")}` : "解散分组";
      break;
    case "canvas_unlink":
      label = `删除关系 ${name(args?.source)} — ${name(args?.target)}`;
      break;
    case "dispatch_task":
      label = `派发任务「${args?.title ?? ""}」`;
      break;
    case "use_skill":
      label = `使用技能：${args?.name ?? ""}`;
      break;
    case "ask_user": {
      const questions = Array.isArray(args?.questions) ? args.questions.filter((q: any) => q?.question) : [];
      label = questions.length ? `提问：${questions.map((q: any) => q.header || q.question).join("、")}` : "提问…";
      return { id, tool, label, status: "running", ask: { questions } };
    }
    case "source_list":
      label = "查看资料清单";
      break;
    case "source_tree":
      label = `查看目录 ${args?.path || "/"}`;
      break;
    case "source_read":
      label = `阅读 ${args?.path ?? "资料"}${args?.offset > 1 ? `（从第 ${args.offset} 行）` : ""}`;
      break;
    case "source_search":
      label = `搜索资料：${args?.query ?? ""}`;
      break;
    case "source_bash":
      label = `执行：${String(args?.command ?? "").slice(0, 80)}`;
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
          // 记下回答；出错（被中止）时为 null
          ...(a.ask ? { ask: { ...a.ask, answers: e.result?.details?.answers ?? null } } : {}),
        }
      : a,
  );
}

function upsertActivity(list: Activity[], a: Activity): Activity[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i < 0) return [...list, a];
  const prev = list[i];
  const sameAsk = JSON.stringify(prev.ask?.questions) === JSON.stringify(a.ask?.questions);
  if (prev.label === a.label && prev.nodeId === a.nodeId && prev.status === a.status && sameAsk) return list;
  return list.map((x, j) => (j === i ? { ...prev, ...a } : x));
}

/** 用户没回答提问就发了新消息：当作跳过，让 agent 接着处理新消息 */
function skipAsks(store: BoardStore, list: Activity[] | undefined) {
  for (const a of list ?? []) if (a.ask && a.status === "running") store.answerAsk(a.id, null);
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
    private sources?: SourceLibrary,
  ) {}

  async init() {
    const defaultParent = () => this.focus.find((id) => this.store.get(id)) ?? null;
    this.drafts = new DraftTracker(this.store, defaultParent);
    const ctx: ToolContext = {
      store: this.store,
      by: "AI",
      defaultParent,
      claimDraft: (id) => this.drafts.claim(id),
      dispatch: (title, instructions, ids) => this.tasks.run(title, instructions, ids.length ? ids : this.focus),
      skills: true,
    };
    this.session = await makeSession(() => MAIN_PROMPT + skillsPrompt(), ctx, this.sources);
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
    const cmd = parseSkillCommand(text);
    const skill = cmd && findSkill(cmd.name);
    if (cmd && !skill) {
      this.store.emit({ type: "error", message: `技能 ${cmd.name} 不存在` });
      return;
    }
    const prompt = this.composePrompt(text, contextNodeIds, skill ? skillBlock(skill) : undefined, cmd?.args);
    this.pending.set(prompt, { text, contextNodeIds });
    if (this.session.isStreaming && this.aiEntry) skipAsks(this.store, this.store.getChat(this.aiEntry)?.activity);
    const run = this.session.isStreaming
      ? this.session.prompt(prompt, { streamingBehavior: mode === "steer" ? "steer" : "followUp" })
      : this.session.prompt(prompt);
    run.catch((err) => this.store.emit({ type: "error", message: String(err?.message ?? err) }));
  }

  private composePrompt(text: string, contextNodeIds: string[], skill?: string, skillArgs?: string) {
    const parts = [`[白板索引]\n${this.store.outline()}`];
    if (skill) parts.push(`[用户指定的技能]\n${skill}`);
    const sources = this.sources?.outline();
    if (sources) parts.push(`[参考资料]\n${sources}`);
    const selected = contextNodeIds.map((id) => this.store.get(id)).filter(Boolean) as BoardNode[];
    if (selected.length) {
      parts.push(
        "[用户选中的节点]\n" +
          selected
            .map((n) => {
              const tag = n.kind === "widget" ? "widget" : "node";
              return `<${tag} id="${n.id}" title="${n.title}" summary="${n.summary}">\n${n.md}\n</${tag}>`;
            })
            .join("\n"),
      );
    }
    parts.push(`[用户消息]\n${skill ? skillArgs || "（按技能开始）" : text}`);
    return parts.join("\n\n");
  }

  abort() {
    this.session.abort();
  }

  get messages(): unknown[] {
    return this.session.messages;
  }

  get modelKey(): string | null {
    const m = this.session.model;
    return m ? `${m.provider}/${m.id}` : null;
  }

  /** 切换模型与思考强度（下一次请求生效） */
  async applyModel() {
    const model = (await resolveModel(settings.model)) ?? this.session.model;
    if (!model) return;
    if (this.modelKey !== `${model.provider}/${model.id}`) await this.session.setModel(model);
    this.session.setThinkingLevel(thinkingFor(model));
  }

  dispose() {
    this.session.abort();
    this.session.dispose();
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
        if (e.assistantMessageEvent.type === "thinking_delta") {
          this.store.appendChat(this.ensureAi(), e.assistantMessageEvent.delta, "thinking");
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

  constructor(
    private store: BoardStore,
    private sources?: SourceLibrary,
  ) {}

  run(title: string, instructions: string, contextNodeIds: string[]): string {
    const task: Task = {
      id: nanoid(6),
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
    const session = await makeSession(() => TASK_PROMPT, ctx, this.sources);
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
    const sources = this.sources?.outline();
    const prompt = `[任务] ${task.title}\n\n${task.instructions}${ctxText ? `\n\n[相关节点]\n${ctxText}` : ""}\n\n[白板索引]\n${this.store.outline()}${sources ? `\n\n[参考资料]\n${sources}` : ""}`;

    await session.prompt(prompt);
    await session.agent.waitForIdle();
    drafts.cleanup();
    if (task.status === "aborted") return;

    const errorMessage = session.agent.state.errorMessage;
    if (errorMessage && !lastText) {
      task.status = "error";
      task.log += `\n\n[错误] ${errorMessage}`;
    } else task.status = "done";
    this.store.upsertTask(task);
    this.onFinished?.(task);
  }

  steer(id: string, text: string) {
    const session = this.sessions.get(id);
    const task = this.store.tasks.get(id);
    if (!session || !task) return;
    task.log += `\n\n> 👤 ${text}\n\n`;
    this.store.upsertTask(task);
    skipAsks(this.store, task.activity);
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

  dispose() {
    for (const s of this.sessions.values()) {
      s.abort();
      s.dispose();
    }
    this.sessions.clear();
  }

  abort(id: string) {
    const task = this.store.tasks.get(id);
    if (!task) return;
    task.status = "aborted";
    this.store.upsertTask(task);
    this.sessions.get(id)?.abort();
  }
}
