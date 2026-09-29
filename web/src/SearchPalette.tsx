import { useEffect, useMemo, useRef, useState } from "react";
import { client, summaryOf, type ClientState } from "./client.ts";
import { ui } from "./ui.ts";

/** ⌘K / Ctrl+K：按标题、摘要、正文搜索节点并定位 */
export function SearchPalette({ state }: { state: ClientState }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const results = useMemo(() => {
    const nodes = [...state.nodes.values()].filter((n) => !n.draft);
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const scored = nodes
      .map((n) => {
        const title = n.title.toLowerCase();
        const summary = summaryOf(n).toLowerCase();
        const md = n.md.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (title.includes(w)) score += title.startsWith(w) ? 6 : 4;
          else if (summary.includes(w)) score += 2;
          else if (md.includes(w)) score += 1;
          else return { n, score: -1, where: "" };
        }
        const where = words.length && !words.every((w) => title.includes(w) || summary.includes(w)) ? snippet(n.md, words[0]) : "";
        return { n, score, where };
      })
      .filter((r) => r.score >= 0);
    if (words.length) scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30);
  }, [q, state.nodes]);

  const pathOf = (id: string) => {
    const parts: string[] = [];
    for (let n = state.nodes.get(id); n?.parentId; ) {
      n = state.nodes.get(n.parentId);
      if (n) parts.unshift(n.title || "未命名");
    }
    return parts.join(" › ");
  };

  const go = (id: string) => {
    setOpen(false);
    ui.focusNode(id);
  };

  if (!open) return null;
  return (
    <div className="palette-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="搜索节点…"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && results[active]) go(results[active].n.id);
          }}
        />
        <div className="palette-list">
          {results.length === 0 && <div className="empty">{client.state.nodes.size ? "没有匹配的节点" : "白板还是空的"}</div>}
          {results.map(({ n, where }, i) => (
            <div
              key={n.id}
              className={`palette-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(n.id)}
            >
              <div className="palette-title">{n.title || summaryOf(n).slice(0, 20) || "未命名"}</div>
              <div className="palette-sub">{where || summaryOf(n)}</div>
              {pathOf(n.id) && <div className="palette-path">{pathOf(n.id)}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function snippet(md: string, word: string) {
  const i = md.toLowerCase().indexOf(word);
  if (i < 0) return "";
  const start = Math.max(0, i - 16);
  return (start > 0 ? "…" : "") + md.slice(start, i + word.length + 30).replace(/\s+/g, " ") + "…";
}
