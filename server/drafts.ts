import type { BoardStore } from "./store.ts";

interface Draft {
  nodeId: string;
  lastEmit: number;
  pending?: NodeJS.Timeout;
}

const THROTTLE_MS = 90;

/**
 * 草稿节点：模型还在流式生成 canvas_create_node 的参数时，就先把节点放到白板上，
 * 标题、摘要、正文边生成边显示；工具真正执行时再把草稿转正（claim）。
 * 否则一次生成很多节点时，前端会长时间没有任何变化。
 */
export class DraftTracker {
  private drafts = new Map<string, Draft>();

  constructor(
    private store: BoardStore,
    private defaultParent: () => string | null,
  ) {}

  /** 处理流式中的工具调用（partial.content 里的 toolCall） */
  update(toolCall: { id: string; name: string; arguments?: any }, final = false) {
    const widget = toolCall.name === "canvas_create_widget";
    if (toolCall.name !== "canvas_create_node" && !widget) return;
    const raw = toolCall.arguments ?? {};
    // 组件的代码放在 md 里
    const args = widget ? { ...raw, md: raw.code } : raw;
    const existing = this.drafts.get(toolCall.id);
    if (!existing) {
      if (!args.title) return;
      const node = this.store.createNode({
        draft: true,
        kind: widget ? "widget" : "note",
        title: String(args.title),
        summary: String(args.summary ?? ""),
        md: String(args.md ?? ""),
        ...this.placement(this.parentOf(args.parentId, final)),
      });
      this.drafts.set(toolCall.id, { nodeId: node.id, lastEmit: Date.now() });
      return;
    }
    const flush = () => {
      existing.pending = undefined;
      existing.lastEmit = Date.now();
      const node = this.store.get(existing.nodeId);
      if (!node?.draft) return;
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "summary", "md"] as const) {
        if (typeof args[k] === "string" && args[k] !== node[k]) patch[k] = args[k];
      }
      const parentId = args.parentId !== undefined ? this.parentOf(args.parentId, final) : undefined;
      if (parentId !== undefined && parentId !== node.parentId) patch.parentId = parentId;
      if (Object.keys(patch).length) this.store.updateNode(node.id, patch);
    };
    clearTimeout(existing.pending);
    if (final || Date.now() - existing.lastEmit >= THROTTLE_MS) flush();
    else existing.pending = setTimeout(flush, THROTTLE_MS);
  }

  /** 工具执行时领取对应的草稿节点 */
  claim(toolCallId: string): string | undefined {
    const d = this.drafts.get(toolCallId);
    if (!d) return;
    clearTimeout(d.pending);
    this.drafts.delete(toolCallId);
    return this.store.get(d.nodeId) ? d.nodeId : undefined;
  }

  /** 打断或出错后，清掉没有转正的草稿 */
  cleanup() {
    for (const d of this.drafts.values()) {
      clearTimeout(d.pending);
      if (this.store.get(d.nodeId)?.draft) this.store.deleteNode(d.nodeId);
    }
    this.drafts.clear();
  }

  /** 省略 parentId 时挂在默认父节点下；新主题放进默认父节点所在的分组 */
  private placement(parentId: string | null | undefined) {
    const fallback = this.defaultParent();
    if (parentId === undefined) return { parentId: fallback };
    if (parentId === null && fallback) return { parentId, groupId: this.store.groupOf(fallback) };
    return { parentId };
  }

  /** 流式中的 id 可能还没写完，只认完整匹配；undefined 表示暂不确定 */
  private parentOf(parentId: unknown, final: boolean): string | null | undefined {
    if (parentId === null || parentId === "root") return null;
    if (typeof parentId !== "string" || !parentId) return undefined;
    const node = final ? this.store.resolve(parentId) : this.store.get(parentId);
    return node?.id;
  }
}
