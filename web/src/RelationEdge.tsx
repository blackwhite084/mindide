import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps } from "@xyflow/react";
import type { BoardEdge } from "../../server/types.ts";
import { LANE_BASE, LANE_STEP } from "./layout.ts";

export type RelationFlowEdge = Edge<
  {
    edge: BoardEdge;
    sourceTitle: string;
    targetTitle: string;
    lane?: number;
    state?: string;
    /** 连到子白板入口卡片、由里面的关系合并出来的线 */
    agg?: boolean;
  },
  "relation"
>;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Pt = [number, number];

/** 三次贝塞尔上 t 处的点 */
function at([p0, p1, p2, p3]: Pt[], t: number): Pt {
  const u = 1 - t;
  const f = (i: 0 | 1) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  return [f(0), f(1)];
}

/**
 * 根据两个节点的相对位置选择连接方式：
 * - 同一列（例如兄弟节点）：从右侧绕出去的弧线，不压在卡片上；
 * - 左右分开：从相对的两侧连接。
 */
function route(s: Rect, t: Rect, lane: number): { pts: Pt[]; arc: boolean } {
  const sy = s.y + s.h / 2;
  const ty = t.y + t.h / 2;
  const sameColumn = s.x < t.x + t.w && t.x < s.x + s.w;
  if (sameColumn) {
    const sx = s.x + s.w;
    const tx = t.x + t.w;
    // 贝塞尔的顶点约在控制点距离的 3/4 处，按车道换算出控制点位置
    const out = Math.max(sx, tx) + ((LANE_BASE + lane * LANE_STEP) * 4) / 3;
    return {
      arc: true,
      pts: [
        [sx, sy],
        [out, sy],
        [out, ty],
        [tx, ty],
      ],
    };
  }
  const leftToRight = t.x >= s.x + s.w;
  const sx = leftToRight ? s.x + s.w : s.x;
  const tx = leftToRight ? t.x : t.x + t.w;
  const c = Math.max(40, Math.abs(tx - sx) / 2) * (leftToRight ? 1 : -1);
  return {
    arc: false,
    pts: [
      [sx, sy],
      [sx + c, sy],
      [tx - c, ty],
      [tx, ty],
    ],
  };
}

function rectOf(n: ReturnType<typeof useInternalNode>): Rect | undefined {
  if (!n?.measured.width || !n.measured.height) return;
  const p = n.internals.positionAbsolute;
  return { x: p.x, y: p.y, w: n.measured.width, h: n.measured.height };
}

/** 弧线的文字贴在弧线外侧（左对齐），直线的文字居中压在线上 */
function Label({
  pt,
  text,
  title,
  selected,
  arc,
  state,
}: {
  pt: Pt;
  text: string;
  title: string;
  selected?: boolean;
  arc: boolean;
  state?: string;
}) {
  const tx = arc ? `${pt[0] + 5}px` : `calc(${pt[0]}px - 50%)`;
  return (
    <div
      className={`rel-label nodrag nopan ${selected ? "selected" : ""} ${state ?? ""}`}
      style={{ transform: `translate(${tx}, calc(${pt[1]}px - 50%))` }}
      title={title}
    >
      {text}
    </div>
  );
}

export function RelationEdge({ id, source, target, data, selected, markerEnd, markerStart }: EdgeProps<RelationFlowEdge>) {
  const s = rectOf(useInternalNode(source));
  const t = rectOf(useInternalNode(target));
  if (!s || !t || !data) return null;
  const { pts, arc } = route(s, t, data.lane ?? 0);
  const [p0, p1, p2, p3] = pts;
  const path = `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`;
  const { edge, sourceTitle, targetTitle } = data;
  const both = edge.dir === "both";
  const hasReverse = both && !!edge.reverseLabel && edge.reverseLabel !== edge.label;
  // 弧线的文字放在最外侧的顶点附近（车道留出了空间），直线则放在中段
  const [tLabel, tReverse] = arc ? (hasReverse ? [0.62, 0.38] : [0.5, 0.5]) : hasReverse ? [0.72, 0.28] : [0.5, 0.5];

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={edge.dir !== "none" ? markerEnd : undefined}
        markerStart={both ? markerStart : undefined}
        interactionWidth={16}
        // 行内样式：导出图片时才能保留线条颜色
        style={{ stroke: "#8b93a3", strokeWidth: 1.4, ...(data.agg ? { strokeDasharray: "5 4" } : {}) }}
      />
      <EdgeLabelRenderer>
        {edge.label && (
          <Label
            pt={at(pts, tLabel)}
            arc={arc}
            text={edge.label}
            title={`${sourceTitle} → ${targetTitle}：${edge.label}`}
            selected={selected}
            state={data.state}
          />
        )}
        {hasReverse && (
          <Label
            pt={at(pts, tReverse)}
            arc={arc}
            text={edge.reverseLabel!}
            title={`${targetTitle} → ${sourceTitle}：${edge.reverseLabel}`}
            selected={selected}
            state={data.state}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
}
