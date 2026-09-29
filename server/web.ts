import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 直接调用 Exa 的 MCP 接口（无需 key，无状态）。
 * 不用 pi-exa-mcp 扩展：它无法解析 Exa 返回的 SSE 响应。
 */
const EXA_URL = process.env.EXA_MCP_URL ?? "https://mcp.exa.ai/mcp";

async function callExa(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (process.env.EXA_API_KEY) headers["x-api-key"] = process.env.EXA_API_KEY;
  const res = await fetch(EXA_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}: ${raw.slice(0, 200)}`);
  // 兼容 SSE（event: message / data: {...}）和普通 JSON 两种响应
  const payload = raw.trimStart().startsWith("{")
    ? raw
    : raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`Exa: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const text = (msg.result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  if (msg.result?.isError) throw new Error(text || "Exa 返回错误");
  return text.length > 30_000 ? text.slice(0, 30_000) + "\n…(已截断)" : text;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export const webSearch = defineTool({
  name: "web_search",
  label: "联网搜索",
  description: "联网搜索，返回相关网页的标题、链接和摘要。需要最新信息或核实事实时使用。",
  parameters: Type.Object({
    query: Type.String({ description: "搜索语句，描述理想的网页内容" }),
    numResults: Type.Optional(Type.Number({ description: "结果数量，默认 5" })),
  }),
  execute: async (_id, { query, numResults }, signal) =>
    text(await callExa("web_search_exa", { query, numResults: numResults ?? 5 }, signal)),
});

export const webFetch = defineTool({
  name: "web_fetch",
  label: "读取网页",
  description: "读取一个或多个网页的正文（Markdown）。搜索摘要不够时使用。",
  parameters: Type.Object({
    urls: Type.Array(Type.String()),
    maxCharacters: Type.Optional(Type.Number({ description: "每页最多字符数，默认 4000" })),
  }),
  execute: async (_id, { urls, maxCharacters }, signal) =>
    text(await callExa("web_fetch_exa", { urls, maxCharacters: maxCharacters ?? 4000 }, signal)),
});

export const WEB_TOOLS = [webSearch, webFetch];
