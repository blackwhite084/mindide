// 子白板的归属计算（前后端共用）：主题上记着 scope，子节点跟随所在主题
import type { BoardNode } from "./types.ts";

type Get = (id: string) => BoardNode | undefined;

/** 防止脏数据里的环 */
const MAX_DEPTH = 64;

/** 节点所在的白板：子白板入口的 id，undefined 为主白板 */
export function scopeOf(get: Get, id: string): string | undefined {
  let n = get(id);
  for (let i = 0; n?.parentId && i < 10_000; i++) {
    const p = get(n.parentId);
    if (!p) break;
    n = p;
  }
  return n?.scope;
}

/** 从主白板到 scope 这一层经过的子白板入口（由外到内） */
export function scopePath(get: Get, scope: string | undefined): string[] {
  const out: string[] = [];
  for (let s = scope; s && out.length < MAX_DEPTH && !out.includes(s); s = scopeOf(get, s)) out.unshift(s);
  return out;
}

/** 所有节点所在的白板（一次算完，供画布按层过滤） */
export function scopeMap(nodes: Iterable<BoardNode>): Map<string, string | undefined> {
  const byId = new Map<string, BoardNode>();
  for (const n of nodes) byId.set(n.id, n);
  const out = new Map<string, string | undefined>();
  const resolve = (id: string, seen = 0): string | undefined => {
    if (out.has(id)) return out.get(id);
    const n = byId.get(id);
    const p = n?.parentId ? byId.get(n.parentId) : undefined;
    const s = p && seen < 10_000 ? resolve(p.id, seen + 1) : n?.scope;
    out.set(id, s);
    return s;
  };
  for (const id of byId.keys()) resolve(id);
  return out;
}

/**
 * 在 view 这一层代表节点 id 的卡片：在这一层的就是它自己，在更深的子白板里就是这一层上的入口卡片；
 * 不在这一层之下（上层或别的子白板里）则为 undefined
 */
export function representative(scopes: Map<string, string | undefined>, id: string, view: string | undefined) {
  let cur = id;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const s = scopes.get(cur);
    if (s === view) return cur;
    if (!s) return undefined;
    cur = s;
  }
  return undefined;
}
