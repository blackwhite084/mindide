import { useMemo, useState } from "react";
import { client, type ClientState } from "./client.ts";
import { diffBoards } from "./compare.ts";

/** 版本对比时画布顶部的横幅：变化汇总、被删除节点（可恢复）、退出对比 */
export function CompareBanner({ state }: { state: ClientState }) {
  const [open, setOpen] = useState(false);
  const diff = useMemo(
    () => (state.compare ? diffBoards(state.compare.board, [...state.nodes.values()], [...state.edges.values()]) : null),
    [state.compare, state.nodes, state.edges],
  );
  if (!state.compare || !diff) return null;
  const added = [...diff.nodes.values()].filter((k) => k === "added").length;
  const modified = diff.nodes.size - added;
  const nothing = !added && !modified && !diff.removed.length && !diff.edgesAdded && !diff.edgesRemoved;

  return (
    <div className="compare-banner">
      <div className="compare-row">
        <span className="compare-title">对比：当前 vs「{state.compare.label}」</span>
        {nothing ? (
          <span className="muted">没有变化</span>
        ) : (
          <>
            {added > 0 && <span className="cmp added">+{added} 新增</span>}
            {modified > 0 && <span className="cmp modified">~{modified} 有改动</span>}
            {diff.removed.length > 0 && (
              <button className="cmp removed ghost" onClick={() => setOpen(!open)}>
                −{diff.removed.length} 已删除 {open ? "▴" : "▾"}
              </button>
            )}
            {(diff.edgesAdded > 0 || diff.edgesRemoved > 0) && (
              <span className="muted">
                关系 +{diff.edgesAdded} / −{diff.edgesRemoved}
              </span>
            )}
          </>
        )}
        <span className="spacer" />
        <button onClick={() => client.endCompare()}>退出对比</button>
      </div>
      {open && diff.removed.length > 0 && (
        <div className="compare-removed nowheel">
          {diff.removed.map((n) => (
            <div key={n.id} className="removed-item">
              <div className="removed-text">
                <div className="removed-title">{n.title || "未命名"}</div>
                {n.summary && <div className="muted">{n.summary}</div>}
              </div>
              <button className="ghost" onClick={() => client.send({ type: "node:restore", node: n })}>
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
