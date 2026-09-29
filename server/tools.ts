import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstLine, type BoardStore } from "./store.ts";
import type { TaskKind } from "./types.ts";
import { WIDGET_GUIDE } from "./widget.ts";

export interface ToolContext {
  store: BoardStore;
  /** 修改者标识，显示在“已修改”里 */
  by: string;
  /** 新建节点未指定 parentId 时的默认父节点（通常是用户选中的节点） */
  defaultParent: () => string | null;
  dispatch?: (kind: TaskKind, title: string, instructions: string, contextNodeIds: string[]) => string;
  /** 领取流式生成时预先放上白板的草稿节点 */
  claimDraft?: (toolCallId: string) => string | undefined;
}

const result = (s: string, nodeId?: string) => ({
  content: [{ type: "text" as const, text: s }],
  details: { nodeId },
});

function must(ctx: ToolContext, id: string) {
  const node = ctx.store.resolve(id);
  if (!node) throw new Error(`节点 ${id} 不存在，先用 canvas_list 查看`);
  return node;
}

/** 等前端跑完组件，把运行结果告诉模型 */
async function widgetReport(ctx: ToolContext, id: string) {
  const r = await ctx.store.waitWidget(id);
  if (!r) return "（暂未收到运行结果：用户可能没有打开这个白板，或节点处于折叠状态）";
  return r.error ? `运行报错，请用 canvas_edit_node 修复：\n${r.error}` : "运行正常";
}

function parentOf(ctx: ToolContext, parentId: string | null | undefined) {
  if (parentId === null || parentId === "" || parentId === "root") return null;
  if (parentId === undefined) return ctx.defaultParent();
  return must(ctx, parentId).id;
}

export function createCanvasTools(ctx: ToolContext) {
  const list = defineTool({
    name: "canvas_list",
    label: "查看白板",
    description: "查看整棵思维树：每个节点的 id、标题和摘要，缩进表示层级",
    parameters: Type.Object({}),
    execute: async () => result(ctx.store.outline(400)),
  });

  const read = defineTool({
    name: "canvas_read",
    label: "读取节点",
    description: "读取一个或多个节点的完整正文",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { description: "节点 id 列表" }) }),
    execute: async (_id, { ids }) =>
      result(
        ids
          .map((id) => {
            const n = must(ctx, id);
            if (n.kind === "widget") {
              const error = ctx.store.widgetResult(n.id)?.error;
              return `<widget id="${n.id}" parent="${n.parentId ?? "root"}" title="${n.title}" summary="${n.summary}">\n${n.md}\n</widget>${error ? `\n<runtime-error>\n${error}\n</runtime-error>` : ""}`;
            }
            return `<node id="${n.id}" parent="${n.parentId ?? "root"}" title="${n.title}" summary="${n.summary}">\n${n.md}\n</node>`;
          })
          .join("\n\n"),
      ),
  });

  const create = defineTool({
    name: "canvas_create_node",
    label: "新建节点",
    description:
      "在思维树上新建一个内容节点。一个节点只讲一个要点；复杂内容拆成父节点 + 若干子节点。",
    // parentId 放在最前面：模型按顺序生成参数，草稿节点一出现就能挂到正确的位置
    parameters: Type.Object({
      parentId: Type.Optional(
        Type.String({ description: "父节点 id；传 root 表示新的主题。省略时挂在用户选中的节点下（没选中则为新主题）" }),
      ),
      title: Type.String({ description: "简短标题，≤ 16 字" }),
      summary: Type.String({ description: "一句话要点摘要，≤ 40 字，折叠时展示" }),
      md: Type.String({ description: "正文 Markdown，可展开查看；没有更多细节时可以为空" }),
    }),
    execute: async (toolCallId, { title, summary, md, parentId }) => {
      const parent = parentOf(ctx, parentId);
      const draftId = ctx.claimDraft?.(toolCallId);
      if (draftId) {
        ctx.store.updateNode(draftId, { title, summary, md, parentId: parent, draft: false });
        return result(`已创建节点 ${draftId}`, draftId);
      }
      const node = ctx.store.createNode({ title, summary, md, parentId: parent }, true);
      return result(`已创建节点 ${node.id}`, node.id);
    },
  });

  const createWidget = defineTool({
    name: "canvas_create_widget",
    label: "新建组件",
    description: `在思维树上新建一个组件节点：一段自己写的 HTML/CSS/JS，在白板上直接运行，用于图表、SVG 插图、流程/结构示意、交互演示、小计算器、白板内容的自定义可视化等文字说不清的内容。\n${WIDGET_GUIDE}`,
    parameters: Type.Object({
      parentId: Type.Optional(
        Type.String({ description: "父节点 id；传 root 表示新的主题。省略时挂在用户选中的节点下（没选中则为新主题）" }),
      ),
      title: Type.String({ description: "简短标题，≤ 16 字" }),
      summary: Type.String({ description: "一句话说明这个组件展示什么，≤ 40 字，折叠时展示" }),
      code: Type.String({ description: "组件的 HTML 代码" }),
    }),
    execute: async (toolCallId, { title, summary, code, parentId }) => {
      const parent = parentOf(ctx, parentId);
      const init = { kind: "widget" as const, title, summary, md: code, parentId: parent, open: true };
      const draftId = ctx.claimDraft?.(toolCallId);
      let id: string;
      if (draftId) {
        ctx.store.updateNode(draftId, { ...init, draft: false });
        id = draftId;
      } else id = ctx.store.createNode(init, true).id;
      return result(`已创建组件 ${id}，${await widgetReport(ctx, id)}`, id);
    },
  });

  const edit = defineTool({
    name: "canvas_edit_node",
    label: "修改节点",
    description:
      "修改已有节点。正文优先用 edits 做局部替换（old 必须在原文中唯一出现），让用户看清改了哪里；只有大改时才传 md 整体重写。组件节点的 md 就是它的 HTML 代码，同样用 edits / md 修改。",
    parameters: Type.Object({
      id: Type.String(),
      edits: Type.Optional(
        Type.Array(Type.Object({ old: Type.String({ description: "原文片段" }), new: Type.String({ description: "替换为" }) })),
      ),
      md: Type.Optional(Type.String({ description: "整体重写后的完整正文" })),
      title: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
    }),
    execute: async (_id, { id, edits, md, title, summary }) => {
      const node = must(ctx, id);
      let next = md ?? node.md;
      for (const e of edits ?? []) {
        const count = next.split(e.old).length - 1;
        if (count === 0) throw new Error(`未找到片段：${e.old.slice(0, 60)}`);
        if (count > 1) throw new Error(`片段出现了 ${count} 次，请提供更长的上下文：${e.old.slice(0, 60)}`);
        next = next.replace(e.old, () => e.new);
      }
      if (title !== undefined && title !== node.title) ctx.store.updateNode(node.id, { title });
      if (summary !== undefined) ctx.store.editNode(node.id, summary, ctx.by, "summary");
      if (next === node.md) return result(`已修改节点 ${node.id}`, node.id);
      ctx.store.editNode(node.id, next, ctx.by);
      if (node.kind !== "widget") return result(`已修改节点 ${node.id}`, node.id);
      // 展开才会运行，也让用户看到改动的效果
      if (!node.open) ctx.store.updateNode(node.id, { open: true });
      return result(`已修改组件 ${node.id}，${await widgetReport(ctx, node.id)}`, node.id);
    },
  });

  const move = defineTool({
    name: "canvas_move_node",
    label: "调整结构",
    description: "把节点（连同子树）挂到另一个父节点下，用于整理层级。parentId 传 root 表示变成独立主题。",
    parameters: Type.Object({ id: Type.String(), parentId: Type.String() }),
    execute: async (_id, { id, parentId }) => {
      const node = must(ctx, id);
      const target = parentOf(ctx, parentId);
      if (target && (target === node.id || ctx.store.isDescendant(target, node.id))) {
        throw new Error("不能挂到自己的子孙节点下");
      }
      ctx.store.updateNode(node.id, { parentId: target });
      return result(`已移动节点 ${node.id}`, node.id);
    },
  });

  const del = defineTool({
    name: "canvas_delete_node",
    label: "删除节点",
    description: "删除一个节点，它的子节点会上移一级。谨慎使用，仅在用户要求或合并整理后使用。",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, { id }) => {
      const node = must(ctx, id);
      ctx.store.deleteNode(node.id);
      return result(`已删除「${node.title || firstLine(node.md)}」`);
    },
  });

  const link = defineTool({
    name: "canvas_link",
    label: "关系",
    description:
      "在两个节点之间建立（或更新）一条带箭头的关系线，并写上关系文字，例如「导致」「依赖」「对比」。父子关系不需要这个。双向关系可以给两个方向写不同的文字。",
    parameters: Type.Object({
      source: Type.String(),
      target: Type.String(),
      label: Type.Optional(Type.String({ description: "source → target 方向的关系，≤ 8 字" })),
      bidirectional: Type.Optional(Type.Boolean({ description: "是否双向" })),
      reverseLabel: Type.Optional(Type.String({ description: "双向时 target → source 方向的关系，≤ 8 字" })),
    }),
    execute: async (_id, { source, target, label, bidirectional, reverseLabel }) => {
      const s = must(ctx, source).id;
      const t = must(ctx, target).id;
      const dir = bidirectional || reverseLabel ? "both" : "forward";
      ctx.store.addEdge(s, t, { dir, label, reverseLabel });
      return result("已建立关系", t);
    },
  });

  const unlink = defineTool({
    name: "canvas_unlink",
    label: "删除关系",
    description: "删除两个节点之间的关系线",
    parameters: Type.Object({ source: Type.String(), target: Type.String() }),
    execute: async (_id, { source, target }) => {
      const e = ctx.store.findEdge(must(ctx, source).id, must(ctx, target).id);
      if (!e) throw new Error("两者之间没有关系线");
      ctx.store.deleteEdge(e.id);
      return result("已删除关系");
    },
  });

  const tools = [list, read, create, createWidget, edit, move, del, link, unlink];

  if (ctx.dispatch) {
    const dispatch = ctx.dispatch;
    tools.push(
      defineTool({
        name: "dispatch_task",
        label: "派发任务",
        description:
          "把耗时的工作派给后台 agent 异步执行，不阻塞对话。research：联网调研并产出报告节点；organize：整理、归纳、重构白板。",
        parameters: Type.Object({
          kind: Type.Union([Type.Literal("research"), Type.Literal("organize")]),
          title: Type.String({ description: "任务标题" }),
          instructions: Type.String({ description: "详细的任务说明" }),
          contextNodeIds: Type.Optional(Type.Array(Type.String(), { description: "相关节点；报告会挂在第一个节点下" })),
        }),
        execute: async (_id, { kind, title, instructions, contextNodeIds }) => {
          const ids = (contextNodeIds ?? []).map((id) => must(ctx, id).id);
          const taskId = dispatch(kind, title, instructions, ids);
          return result(`已派发任务 ${taskId}，结果会自动出现在白板上`);
        },
      }) as (typeof tools)[number],
    );
  }

  return tools;
}
