import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SourceLibrary } from "./sources.ts";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** 查阅参考资料（上传的文件、本地目录）的只读工具 */
export function createSourceTools(lib: SourceLibrary) {
  const must = (id: string) => {
    const src = lib.get(id);
    if (!src) throw new Error(`资料 ${id} 不存在，先用 source_list 查看`);
    if (src.status !== "ready") throw new Error(`资料「${src.name}」还不可用：${src.error ?? src.status}`);
    return src;
  };

  return [
    defineTool({
      name: "source_list",
      label: "资料清单",
      description: "列出用户提供的参考资料（上传的文件、本地目录如代码库）",
      parameters: Type.Object({}),
      execute: async () => text(lib.outline() || "(还没有参考资料)"),
    }),
    defineTool({
      name: "source_tree",
      label: "查看目录",
      description: "查看目录类资料的结构（遵守 .gitignore）。path 为子目录，depth 为展开层数",
      parameters: Type.Object({
        source: Type.String({ description: "资料 id" }),
        path: Type.Optional(Type.String({ description: "子目录（相对路径）" })),
        depth: Type.Optional(Type.Number({ description: "展开层数，默认 2" })),
      }),
      execute: async (_id, { source, path, depth }) => text(await lib.tree(must(source), path ?? "", depth ?? 2)),
    }),
    defineTool({
      name: "source_read",
      label: "阅读资料",
      description: "分段阅读资料内容（带行号）。文件类资料不用 path；目录类资料 path 为文件相对路径。PDF 带有「第 N 页」标记",
      parameters: Type.Object({
        source: Type.String({ description: "资料 id" }),
        path: Type.Optional(Type.String({ description: "目录内的文件相对路径" })),
        offset: Type.Optional(Type.Number({ description: "起始行号，默认 1" })),
        limit: Type.Optional(Type.Number({ description: "读取行数，默认 200" })),
      }),
      execute: async (_id, { source, path, offset, limit }) => text(await lib.read(must(source), path, offset, limit)),
    }),
    defineTool({
      name: "source_search",
      label: "搜索资料",
      description: "在资料中全文搜索关键词（不区分大小写），返回 文件:行号: 内容。先搜索定位，再用 source_read 读上下文",
      parameters: Type.Object({
        query: Type.String({ description: "关键词" }),
        source: Type.Optional(Type.String({ description: "只搜某个资料；省略则搜全部" })),
      }),
      execute: async (_id, { query, source }) => text(await lib.search(query, source ? must(source) : undefined)),
    }),
  ];
}
