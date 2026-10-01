import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";

/** 无序卡片墙的虚线框：只是装饰，鼠标事件穿透 */
export type WallFlowNode = Node<{ color: string }, "wall">;

function WallNodeInner({ data }: NodeProps<WallFlowNode>) {
  return <div className="wall-box" style={{ "--wc": data.color } as React.CSSProperties} title="无序：这些卡片没有先后" />;
}

export const WallNode = memo(WallNodeInner);
