import type { BoardEdge, BoardNode } from "../../server/types.ts";

/** 导入导出用的精简结构（不含对话、布局状态） */
export interface Fragment {
  nodes: Pick<BoardNode, "id" | "title" | "summary" | "md" | "parentId" | "kind">[];
  edges: Pick<BoardEdge, "source" | "target" | "dir" | "label" | "reverseLabel">[];
}

const arrowOf = (e: Fragment["edges"][number]) => (e.dir === "both" ? "↔" : e.dir === "none" ? "—" : "→");

/** 按思维树导出 Markdown：层级用标题表示，摘要用引用，正文原样保留 */
export function toMarkdown(nodes: BoardNode[], edges: BoardEdge[]): string {
  const kids = new Map<string | null, BoardNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => a.createdAt - b.createdAt);

  const out: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const n of kids.get(parentId) ?? []) {
      const title = n.title || n.summary || "未命名";
      if (depth < 6) out.push(`${"#".repeat(depth + 1)} ${title}`, "");
      else out.push(`${"  ".repeat(depth - 6)}- **${title}**`, "");
      if (n.summary && n.summary !== title) out.push(`> ${n.summary}`, "");
      // 正文里的标题降级，避免打乱导出的层级
      if (n.kind === "widget") {
        if (n.md.trim()) out.push("```html", n.md.trim(), "```", "");
        walk(n.id, depth + 1);
        continue;
      }
      const body = n.md.trim().replace(/^(#{1,6})\s/gm, (_m, h: string) => `${"#".repeat(Math.min(6, h.length + depth + 1))} `);
      if (body) out.push(body, "");
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);

  const titleOf = new Map(nodes.map((n) => [n.id, n.title || n.summary || "未命名"]));
  const rel = edges.filter((e) => titleOf.has(e.source) && titleOf.has(e.target));
  if (rel.length) {
    out.push("---", "", "**关系**", "");
    for (const e of rel) {
      const text = [e.label, e.dir === "both" ? e.reverseLabel : ""].filter(Boolean).join(" / ");
      out.push(`- ${titleOf.get(e.source)} ${arrowOf(e)} ${titleOf.get(e.target)}${text ? `：${text}` : ""}`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function toJSON(nodes: BoardNode[], edges: BoardEdge[]): string {
  const data: Fragment & { format: string; version: number; exportedAt: string } = {
    format: "ai-minder",
    version: 1,
    exportedAt: new Date().toISOString(),
    nodes: nodes.map(({ id, title, summary, md, parentId, kind }) => ({ id, title, summary, md, parentId, kind })),
    edges: edges.map(({ source, target, dir, label, reverseLabel }) => ({ source, target, dir, label, reverseLabel })),
  };
  return JSON.stringify(data, null, 2);
}

let seq = 0;
const newId = () => `imp${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Markdown → 思维树：
 * - 有标题时按标题层级建树，标题下的内容是正文，紧跟的引用是摘要；
 * - 没有标题时按嵌套列表建树。
 */
export function fromMarkdown(text: string, fallbackTitle = "导入的内容"): Fragment {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nodes: Fragment["nodes"] = [];
  const hasHeadings = lines.some((l) => /^#{1,6}\s+\S/.test(l));

  if (hasHeadings) {
    const stack: { id: string; level: number }[] = [];
    let current: Fragment["nodes"][number] | undefined;
    let body: string[] = [];
    let inFence = false;
    const flush = () => {
      if (!current) return;
      const trimmed = body.join("\n").trim();
      const quote = trimmed.match(/^>\s?(.+)(\n|$)/);
      if (quote && !current.summary) {
        current.summary = quote[1].trim();
        current.md = trimmed.slice(quote[0].length).trim();
      } else current.md = trimmed;
      body = [];
    };
    for (const line of lines) {
      if (/^```/.test(line)) inFence = !inFence;
      const h = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!h) {
        if (current) body.push(line);
        else if (line.trim()) {
          // 第一个标题之前的内容，放到一个前言节点里
          current = { id: newId(), title: fallbackTitle, summary: "", md: "", parentId: null, kind: "note" };
          nodes.push(current);
          stack.push({ id: current.id, level: 0 });
          body.push(line);
        }
        continue;
      }
      flush();
      const level = h[1].length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      current = {
        id: newId(),
        title: h[2].replace(/\*\*/g, "").trim(),
        summary: "",
        md: "",
        parentId: stack.at(-1)?.id ?? null,
        kind: "note",
      };
      nodes.push(current);
      stack.push({ id: current.id, level });
    }
    flush();
    return { nodes, edges: [] };
  }

  // 列表模式：按缩进建树
  const stack: { id: string; indent: number }[] = [];
  let last: Fragment["nodes"][number] | undefined;
  for (const line of lines) {
    const m = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (!m) {
      if (last && line.trim()) last.md = (last.md ? last.md + "\n" : "") + line.trim();
      continue;
    }
    const indent = m[1].replace(/\t/g, "  ").length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const [title, ...rest] = m[2].replace(/\*\*/g, "").split(/[：:]\s*/);
    last = {
      id: newId(),
      title: title.trim().slice(0, 40),
      summary: rest.join("：").trim(),
      md: "",
      parentId: stack.at(-1)?.id ?? null,
      kind: "note",
    };
    nodes.push(last);
    stack.push({ id: last.id, indent });
  }
  if (!nodes.length && text.trim()) {
    nodes.push({ id: newId(), title: fallbackTitle, summary: "", md: text.trim(), parentId: null, kind: "note" });
  }
  // 多个顶层条目时，包一层主题节点
  const roots = nodes.filter((n) => !n.parentId);
  if (roots.length > 1) {
    const root = { id: newId(), title: fallbackTitle, summary: "", md: "", parentId: null, kind: "note" as const };
    for (const r of roots) r.parentId = root.id;
    nodes.unshift(root);
  }
  return { nodes, edges: [] };
}

export function fromJSON(text: string): Fragment {
  const data = JSON.parse(text);
  // 兼容：导出文件 / data/board.json（{ board: {...} }）/ 裸 board
  const src = data.board ?? data;
  if (!Array.isArray(src.nodes)) throw new Error("不是有效的 AI Minder 文件");
  return {
    nodes: src.nodes
      .filter((n: any) => n && n.id && !n.draft)
      .map((n: any) => ({
        id: String(n.id),
        title: String(n.title ?? ""),
        summary: String(n.summary ?? ""),
        md: String(n.md ?? ""),
        parentId: n.parentId ?? null,
        kind: n.kind === "task" || n.kind === "widget" ? n.kind : "note",
      })),
    edges: (src.edges ?? [])
      .filter((e: any) => e && e.source && e.target)
      .map((e: any) => ({
        source: String(e.source),
        target: String(e.target),
        dir: e.dir === "both" || e.dir === "none" ? e.dir : "forward",
        label: e.label,
        reverseLabel: e.reverseLabel,
      })),
  };
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0]);
    input.click();
  });
}
