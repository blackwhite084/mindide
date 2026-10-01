import { useState } from "react";
import { client, type ClientState } from "./client.ts";
import { ui } from "./ui.ts";

/** 标签的颜色由名字决定，不用配置 */
export function tagColor(tag: string) {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 68%)`;
}

const clean = (s: string) => s.replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 20);

function counts(state: ClientState) {
  const m = new Map<string, number>();
  for (const n of state.nodes.values()) for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** 画布左上角：所有标签，点击按标签筛选（其余节点变淡） */
export function TagBar({ state }: { state: ClientState }) {
  const all = counts(state);
  if (!all.length) return null;
  return (
    <div className="tag-bar">
      {all.map(([t, c]) => (
        <button
          key={t}
          className={`tag-chip ${state.tagFilter === t ? "on" : ""}`}
          style={{ "--tc": tagColor(t) } as React.CSSProperties}
          onClick={() => client.setTagFilter(state.tagFilter === t ? null : t)}
        >
          {t} <span className="tag-count">{c}</span>
        </button>
      ))}
      {state.tagFilter && (
        <button className="ghost" onClick={() => client.setTagFilter(null)}>
          清除筛选
        </button>
      )}
    </div>
  );
}

/** 给一个或多个节点增删标签 */
export function TagForm({ ids }: { ids: string[] }) {
  const [text, setText] = useState("");
  const nodes = ids.map((id) => client.state.nodes.get(id)).filter(Boolean);
  const [version, setVersion] = useState(0);
  void version;
  // 多个节点时：只有所有节点都有的标签才算“已有”
  const current = (nodes[0]?.tags ?? []).filter((t) => nodes.every((n) => n!.tags?.includes(t)));
  const known = counts(client.state).map(([t]) => t).filter((t) => !current.includes(t));

  const apply = (tag: string, add: boolean) => {
    const t = clean(tag);
    if (!t) return;
    for (const id of ids) {
      const n = client.state.nodes.get(id);
      if (!n) continue;
      const tags = (n.tags ?? []).filter((x) => x !== t);
      client.patchNode(id, { tags: add ? [...tags, t] : tags });
    }
    setText("");
    setVersion((v) => v + 1);
  };

  return (
    <div className="rel-form tag-form">
      <div className="rel-dir">{ids.length > 1 ? `${ids.length} 个节点的标签` : "标签"}</div>
      <div className="tag-chips wrap">
        {current.length === 0 && <span className="muted">还没有标签</span>}
        {current.map((t) => (
          <button key={t} className="tag-chip" style={{ "--tc": tagColor(t) } as React.CSSProperties} title="点击移除" onClick={() => apply(t, false)}>
            {t} ×
          </button>
        ))}
      </div>
      <input
        autoFocus
        value={text}
        placeholder="输入标签，回车添加"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") apply(text, true);
        }}
      />
      {known.length > 0 && (
        <div className="tag-chips wrap">
          {known.slice(0, 16).map((t) => (
            <button key={t} className="tag-chip dim" style={{ "--tc": tagColor(t) } as React.CSSProperties} onClick={() => apply(t, true)}>
              + {t}
            </button>
          ))}
        </div>
      )}
      <div className="rel-actions">
        <button className="primary" onClick={() => ui.closeMenu()}>
          完成
        </button>
      </div>
    </div>
  );
}
