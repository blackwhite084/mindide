import { useMemo } from "react";
import type { VersionMeta } from "../../server/types.ts";
import { client, type ClientState } from "./client.ts";

const ROW = 40;
const LANE = 16;
const PAD = 12;
const LANE_COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e"];

interface Row {
  v: VersionMeta;
  lane: number;
  row: number;
}

/** 按时间排布，每条分支占一列：父版本的第一个子版本沿用父的列，其余子版本另开新列 */
function layout(versions: VersionMeta[]) {
  const sorted = [...versions].sort((a, b) => a.at - b.at);
  const lanes = new Map<string, number>();
  const continued = new Set<string>();
  let maxLane = 0;
  for (const v of sorted) {
    let lane = 0;
    if (v.parentId && lanes.has(v.parentId)) {
      if (!continued.has(v.parentId)) {
        lane = lanes.get(v.parentId)!;
        continued.add(v.parentId);
      } else {
        lane = ++maxLane;
      }
    }
    lanes.set(v.id, lane);
  }
  const rows: Row[] = sorted.reverse().map((v, i) => ({ v, lane: lanes.get(v.id)!, row: i }));
  return { rows, lanes: maxLane + 1 };
}

export function VersionPanel({ state }: { state: ClientState }) {
  const { rows, lanes } = useMemo(() => layout(state.versions), [state.versions]);
  const byId = new Map(rows.map((r) => [r.v.id, r]));
  const width = PAD + lanes * LANE;
  const cx = (lane: number) => PAD / 2 + lane * LANE + 4;
  const cy = (row: number) => row * ROW + ROW / 2;

  // 从当前版本一路到根的路径，高亮显示
  const onPath = new Set<string>();
  for (let id = state.head; id; id = byId.get(id)?.v.parentId ?? null) onPath.add(id);

  return (
    <div className="versions">
      <div className="versions-head">
        <span className="muted">点击任意版本回到那一刻，继续操作会长出新分支</span>
        <button onClick={() => client.send({ type: "version:save" })}>存一个版本</button>
      </div>
      <div className="versions-graph" style={{ height: rows.length * ROW }}>
        <svg width={width} height={rows.length * ROW} className="versions-svg">
          {rows.map(({ v, lane, row }) => {
            const p = v.parentId ? byId.get(v.parentId) : undefined;
            if (!p) return null;
            const x1 = cx(lane), y1 = cy(row), x2 = cx(p.lane), y2 = cy(p.row);
            const color = LANE_COLORS[lane % LANE_COLORS.length];
            const d = x1 === x2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} L${x1},${y2 - ROW / 2} Q${x1},${y2} ${x2},${y2}`;
            return (
              <path key={v.id} d={d} stroke={color} strokeWidth={onPath.has(v.id) ? 2.2 : 1.4} fill="none" opacity={onPath.has(v.id) ? 1 : 0.5} />
            );
          })}
          {rows.map(({ v, lane, row }) => (
            <circle
              key={v.id}
              cx={cx(lane)}
              cy={cy(row)}
              r={v.id === state.head ? 5.5 : 4}
              fill={v.id === state.head ? LANE_COLORS[lane % LANE_COLORS.length] : "var(--panel)"}
              stroke={LANE_COLORS[lane % LANE_COLORS.length]}
              strokeWidth={2}
            />
          ))}
        </svg>
        {rows.map(({ v, row }) => (
          <div
            key={v.id}
            className={`version-row ${v.id === state.head ? "head" : ""} ${onPath.has(v.id) ? "on-path" : ""}`}
            style={{ top: row * ROW, height: ROW, paddingLeft: width + 4 }}
            onClick={() => v.id !== state.head && client.send({ type: "version:checkout", id: v.id })}
            title={v.id === state.head ? "当前版本" : "回到这个版本"}
          >
            <div className="version-label">{v.label}</div>
            <div className="version-meta">
              {new Date(v.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {v.nodeCount} 个节点
              {v.id === state.head && <span className="version-head">当前</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
