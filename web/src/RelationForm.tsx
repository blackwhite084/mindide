import { useState } from "react";
import type { BoardEdge } from "../../server/types.ts";
import { client } from "./client.ts";
import { ui } from "./ui.ts";

/** 编辑关系文字；双向时两个方向可以写不同的文字 */
export function RelationForm({ edge, sourceTitle, targetTitle }: { edge: BoardEdge; sourceTitle: string; targetTitle: string }) {
  const [label, setLabel] = useState(edge.label ?? "");
  const [reverse, setReverse] = useState(edge.reverseLabel ?? "");
  const [both, setBoth] = useState(edge.dir === "both");

  const save = () => {
    client.send({
      type: "edge:update",
      id: edge.id,
      patch: {
        dir: both ? "both" : edge.dir === "none" ? "none" : "forward",
        label: label.trim(),
        reverseLabel: both ? reverse.trim() : "",
      },
    });
    ui.closeMenu();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") save();
  };

  return (
    <div className="rel-form">
      <label>
        <span className="rel-dir">
          {sourceTitle} → {targetTitle}
        </span>
        <input autoFocus value={label} placeholder="关系，例如「导致」" onChange={(e) => setLabel(e.target.value)} onKeyDown={onKey} />
      </label>
      <label className="rel-both">
        <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
        双向
      </label>
      {both && (
        <label>
          <span className="rel-dir">
            {targetTitle} → {sourceTitle}
          </span>
          <input value={reverse} placeholder="反方向的关系（可选）" onChange={(e) => setReverse(e.target.value)} onKeyDown={onKey} />
        </label>
      )}
      <div className="rel-actions">
        <button className="ghost" onClick={() => ui.closeMenu()}>
          取消
        </button>
        <button className="primary" onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}
