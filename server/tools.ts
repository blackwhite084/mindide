import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstLine, type BoardStore } from "./store.ts";
import { WIDGET_GUIDE } from "./widget.ts";
import { findSkill, listSkills, skillBlock } from "./skills.ts";

export interface ToolContext {
  store: BoardStore;
  /** 修改者标识，显示在“已修改”里 */
  by: string;
  /** 新建节点未指定 parentId 时的默认父节点（通常是用户选中的节点） */
  defaultParent: () => string | null;
  /** 用户所在的子白板（undefined 为主白板）：没有选中节点时新主题放在这里 */
  view?: () => string | undefined;
  dispatch?: (title: string, instructions: string, contextNodeIds: string[]) => string;
  /** 领取流式生成时预先放上白板的草稿节点 */
  claimDraft?: (toolCallId: string) => string | undefined;
  /** 允许使用技能（use_skill） */
  skills?: boolean;
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

const tagAttr = (n: { tags?: string[] }) => (n.tags?.length ? ` tags="${n.tags.join(",")}"` : "");

const SIDE_DESC =
  "放在父节点的哪一边：left 左边、right 右边、bottom 下边（在父节点正下方，适合补充说明、结论或总结）；" +
  "省略时跟随父节点的展开方向（默认向右）。子树会沿这个方向继续展开。适合把正反两面、对立方案分在左右两边。";

const TAGS_DESC = "标签：自由文本的短标记（状态、类型、优先级……），不带 #；优先复用白板上已有的标签";

function parentOf(ctx: ToolContext, parentId: string | null | undefined) {
  if (parentId === null || parentId === "" || parentId === "root") return null;
  if (parentId === undefined) return ctx.defaultParent();
  return must(ctx, parentId).id;
}

/** 新主题默认放进用户选中节点所在的分组和白板；没有选中时放在用户所在的白板 */
function topicPlace(ctx: ToolContext, parent: string | null) {
  if (parent) return {};
  const focus = ctx.defaultParent();
  return focus ? { groupId: ctx.store.groupOf(focus), scope: ctx.store.scopeOf(focus) } : { scope: ctx.view?.() };
}

/** 子白板的入口卡片 */
function mustBoard(ctx: ToolContext, id: string) {
  const node = must(ctx, id);
  if (!node.subboard) throw new Error(`节点 ${id} 不是子白板`);
  return node;
}

function mustGroup(ctx: ToolContext, id: string) {
  const group = ctx.store.resolveGroup(id);
  if (!group) throw new Error(`分组 ${id} 不存在，先用 canvas_list 查看`);
  return group;
}

export function createCanvasTools(ctx: ToolContext) {
  /** 向用户提问，等用户在对话里回答后才返回 */
  const askUser = () =>
    defineTool({
      name: "ask_user",
      label: "提问",
      description:
        "向用户提问并等待回答：需求有歧义、有几个方向需要用户拍板、缺少只有用户知道的信息时使用。" +
        "一次可以问 1~4 个问题，每个问题可以给 2~4 个候选项（单选或多选），用户也总能自己输入回答；没有合适候选项时省略 options，让用户直接输入。" +
        "能合理假设的小事不要问，直接做。",
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            question: Type.String({ description: "完整的问题，以问号结尾" }),
            header: Type.Optional(Type.String({ description: "很短的标签，≤ 6 字，如「方向」「范围」" })),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  label: Type.String({ description: "候选项，1~8 字" }),
                  description: Type.Optional(Type.String({ description: "这个选项意味着什么、有什么取舍" })),
                }),
                { description: "2~4 个互斥的候选项（多选时可以不互斥）；不用自己加「其他」，用户总能自己输入" },
              ),
            ),
            multiSelect: Type.Optional(Type.Boolean({ description: "允许多选" })),
          }),
          { minItems: 1, maxItems: 4 },
        ),
      }),
      execute: async (toolCallId, { questions }, signal) => {
        const answers = await ctx.store.waitAnswer(toolCallId, signal);
        const text = answers
          ? "用户的回答：\n" +
            questions
              .map((q, i) => {
                const a = answers[i];
                const parts = [...(a?.selected ?? []), ...(a?.text?.trim() ? [a.text.trim()] : [])];
                return `${i + 1}. ${q.question}\n   → ${parts.length ? parts.join("；") : "（未回答）"}`;
              })
              .join("\n")
          : "用户跳过了这些问题，请按你的判断继续。";
        return { content: [{ type: "text" as const, text }], details: { answers } };
      },
    });

  const list = defineTool({
    name: "canvas_list",
    label: "查看白板",
    description:
      "查看整棵思维树：每个节点的 id、标题、摘要和标签，缩进表示层级；有分组时按分组分段，有子白板时每个子白板单独一段。传 tag 时只列出带该标签的节点（平铺）。",
    parameters: Type.Object({ tag: Type.Optional(Type.String({ description: "只看带这个标签的节点，如 todo" })) }),
    execute: async (_id, { tag }) => result(ctx.store.outline(400, tag)),
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
              return `<widget id="${n.id}" parent="${n.parentId ?? "root"}" title="${n.title}" summary="${n.summary}"${tagAttr(n)}>\n${n.md}\n</widget>${error ? `\n<runtime-error>\n${error}\n</runtime-error>` : ""}`;
            }
            return `<node id="${n.id}" parent="${n.parentId ?? "root"}" title="${n.title}" summary="${n.summary}"${tagAttr(n)}>\n${n.md}\n</node>`;
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
      tags: Type.Optional(Type.Array(Type.String(), { description: TAGS_DESC })),
      side: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("bottom")], { description: SIDE_DESC })),
    }),
    execute: async (toolCallId, { title, summary, md, parentId, tags, side }) => {
      const parent = parentOf(ctx, parentId);
      const draftId = ctx.claimDraft?.(toolCallId);
      if (draftId) {
        ctx.store.updateNode(draftId, { title, summary, md, parentId: parent, draft: false, ...(tags ? { tags } : {}), ...(side ? { side } : {}) });
        return result(`已创建节点 ${draftId}`, draftId);
      }
      const node = ctx.store.createNode({ title, summary, md, parentId: parent, ...topicPlace(ctx, parent), tags, side }, true);
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
      } else id = ctx.store.createNode({ ...init, ...topicPlace(ctx, parent) }, true).id;
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
      addTags: Type.Optional(Type.Array(Type.String(), { description: "要添加的" + TAGS_DESC })),
      removeTags: Type.Optional(Type.Array(Type.String(), { description: "要移除的标签" })),
      side: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("bottom"), Type.Literal("auto")], {
          description: SIDE_DESC + " auto 表示清除设置。",
        }),
      ),
    }),
    execute: async (_id, { id, edits, md, title, summary, addTags, removeTags, side }) => {
      const node = must(ctx, id);
      if (side) ctx.store.updateNode(node.id, { side, ...(node.pinned ? { pinned: false } : {}) });
      if (addTags?.length || removeTags?.length) ctx.store.addRemoveTags(node.id, addTags, removeTags);
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
    description: "把节点（连同子树）挂到另一个父节点下，用于整理层级。parentId 传 root 表示变成独立主题。可同时指定放在父节点的哪一边。",
    parameters: Type.Object({
      id: Type.String(),
      parentId: Type.String(),
      side: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("bottom"), Type.Literal("auto")], { description: SIDE_DESC }),
      ),
    }),
    execute: async (_id, { id, parentId, side }) => {
      const node = must(ctx, id);
      const target = parentOf(ctx, parentId);
      if (target && (target === node.id || ctx.store.isDescendant(target, node.id))) {
        throw new Error("不能挂到自己的子孙节点下");
      }
      if (target && ctx.store.scopeOf(target) !== ctx.store.scopeOf(node.id) && ctx.store.isInside(target, node.id)) {
        throw new Error("不能挂进自己这个子白板里面");
      }
      ctx.store.updateNode(node.id, { parentId: target, ...(side ? { side } : {}) });
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

  const group = defineTool({
    name: "canvas_group",
    label: "分组",
    description:
      "分组是画布上的一块区域，装若干个完整的主题，用来把白板分成几块、减少杂乱（分组不属于思维树，主题内部的层级仍然用父子节点表达）。" +
      "不传 groupId 时新建分组并装入 ids；传 groupId 时把 ids 加进这个已有分组，或修改标题、折叠状态。" +
      "ids 里的非主题节点会从原来的树上断开，成为分组里的新主题。",
    parameters: Type.Object({
      groupId: Type.Optional(Type.String({ description: "已有分组的 id；省略则新建" })),
      title: Type.Optional(Type.String({ description: "分组标题，≤ 12 字；新建时必填" })),
      ids: Type.Optional(Type.Array(Type.String(), { description: "要放进分组的节点 id" })),
      fold: Type.Optional(Type.Boolean({ description: "折叠成一张小卡片（次要内容可以折叠）" })),
    }),
    execute: async (_id, { groupId, title, ids, fold }) => {
      const nodeIds = (ids ?? []).map((id) => must(ctx, id).id);
      if (!groupId) {
        if (!title) throw new Error("新建分组需要 title");
        const g = ctx.store.createGroup({ title, nodeIds, scope: ctx.view?.() });
        if (fold) ctx.store.updateGroup(g.id, { fold });
        return result(`已创建分组 ${g.id}`);
      }
      const g = mustGroup(ctx, groupId);
      for (const id of nodeIds) ctx.store.moveToGroup(id, g.id);
      ctx.store.updateGroup(g.id, { title, fold });
      return result(`已更新分组 ${g.id}`);
    },
  });

  const ungroup = defineTool({
    name: "canvas_ungroup",
    label: "移出分组",
    description: "把节点移出分组（变成未分组的主题）；只传 groupId 时解散整个分组，里面的主题保留。",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "要移出分组的节点 id" })),
      groupId: Type.Optional(Type.String({ description: "要解散的分组 id" })),
    }),
    execute: async (_id, { ids, groupId }) => {
      if (ids?.length) {
        for (const id of ids) ctx.store.moveToGroup(must(ctx, id).id, null);
        return result(`已移出 ${ids.length} 个节点`);
      }
      if (!groupId) throw new Error("需要 ids 或 groupId");
      ctx.store.deleteGroup(mustGroup(ctx, groupId).id);
      return result("已解散分组");
    },
  });

  const subboard = defineTool({
    name: "canvas_subboard",
    label: "子白板",
    description:
      "子白板是白板上的一张入口卡片，点进去是一块独立的画布（可以有多个主题和分组），用来把一大块内容移出当前画面、减少杂乱。" +
      "用法：只传 id —— 把这个节点转为子白板，它的子节点成为子白板里的主题（适合展开得太大的分支）；" +
      "传 ids + title —— 新建子白板，入口卡片放在这些节点原来的位置，节点连同子树收进去；" +
      "传 ids + boardId —— 把节点（连同子树）移进已有的子白板，boardId 传 main 表示移回主白板；" +
      "传 boardId + dissolve —— 解散子白板，里面的分组移到上一层、其余主题挂回入口卡片下。" +
      "跨白板的关系线会保留。",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "要转为子白板的节点 id" })),
      ids: Type.Optional(Type.Array(Type.String(), { description: "要收进子白板的节点 id" })),
      title: Type.Optional(Type.String({ description: "新子白板的标题，≤ 16 字" })),
      boardId: Type.Optional(Type.String({ description: "已有子白板（入口卡片）的 id，或 main" })),
      dissolve: Type.Optional(Type.Boolean({ description: "解散 boardId 这个子白板" })),
    }),
    execute: async (_id, { id, ids, title, boardId, dissolve }) => {
      if (dissolve) {
        if (!boardId) throw new Error("解散需要 boardId");
        const b = mustBoard(ctx, boardId);
        ctx.store.dissolveSubboard(b.id);
        return result(`已解散子白板「${b.title}」`, b.id);
      }
      const nodeIds = (ids ?? []).map((i) => must(ctx, i).id);
      if (nodeIds.length && boardId) {
        const scope = boardId === "main" || boardId === "root" ? undefined : mustBoard(ctx, boardId).id;
        for (const nid of nodeIds) {
          if (scope && (nid === scope || ctx.store.isInside(scope, nid) || ctx.store.isDescendant(scope, nid))) {
            throw new Error(`不能把 ${nid} 移进它自己里面的子白板`);
          }
          ctx.store.moveToScope(nid, scope);
        }
        return result(`已移动 ${nodeIds.length} 个节点到${scope ? `子白板 ${scope}` : "主白板"}`, scope);
      }
      if (nodeIds.length) {
        if (!title) throw new Error("新建子白板需要 title");
        const entry = ctx.store.createSubboard({ title, nodeIds });
        if (!entry) throw new Error("没有可以收进去的节点");
        return result(`已创建子白板 ${entry.id}，收进 ${nodeIds.length} 个节点`, entry.id);
      }
      if (id) {
        const node = must(ctx, id);
        if (node.subboard) throw new Error("它已经是子白板");
        ctx.store.convertToSubboard(node.id);
        if (title && title !== node.title) ctx.store.updateNode(node.id, { title });
        return result(`已把「${node.title}」转为子白板`, node.id);
      }
      throw new Error("需要 id、ids 或 boardId");
    },
  });

  const tools = [list, read, create, createWidget, edit, move, del, link, unlink, group, ungroup, subboard, askUser()];

  if (ctx.dispatch) {
    const dispatch = ctx.dispatch;
    tools.push(
      defineTool({
        name: "dispatch_task",
        label: "派发任务",
        description:
          "把耗时的工作（深入调研、大规模整理重构白板等）派给后台 agent 异步执行，不阻塞对话。后台 agent 可按需联网，结果直接写进白板。",
        parameters: Type.Object({
          title: Type.String({ description: "任务标题" }),
          instructions: Type.String({ description: "详细的任务说明" }),
          contextNodeIds: Type.Optional(Type.Array(Type.String(), { description: "相关节点；新内容默认挂在第一个节点下" })),
        }),
        execute: async (_id, { title, instructions, contextNodeIds }) => {
          const ids = (contextNodeIds ?? []).map((id) => must(ctx, id).id);
          const taskId = dispatch(title, instructions, ids);
          return result(`已派发任务 ${taskId}，结果会自动出现在白板上`);
        },
      }) as (typeof tools)[number],
    );
  }

  if (ctx.skills) {
    tools.push(
      defineTool({
        name: "use_skill",
        label: "使用技能",
        description:
          "读取一个技能（固定的工作流程）并按它的流程工作。用户的需求明显符合系统提示里列出的某个技能、而用户没有指定时使用。",
        parameters: Type.Object({ name: Type.String({ description: "技能名" }) }),
        execute: async (_id, { name }) => {
          const skill = findSkill(name);
          if (!skill) throw new Error(`技能 ${name} 不存在，可用：${listSkills().map((s) => s.name).join("、") || "（无）"}`);
          return result(`${skillBlock(skill)}\n\n现在按这个技能的流程开始。`);
        },
      }) as (typeof tools)[number],
    );
  }

  return tools;
}
