import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ui } from "./ui.ts";

export function ContextMenu() {
  const menu = useSyncExternalStore(ui.subscribeMenu, ui.getMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // 贴边时向内收，避免菜单超出窗口
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      ui.closeMenu();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("wheel", close, true);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x || menu.x, top: pos.y || menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.form ??
        menu.items.map((item, i) => {
          if ("sep" in item) return <div key={i} className="ctx-sep" />;
          if ("title" in item) return <div key={i} className="ctx-title">{item.title}</div>;
          return (
            <button
              key={i}
              className={`ctx-item ${item.danger ? "danger" : ""}`}
              onClick={() => {
                ui.closeMenu();
                item.onClick();
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
            </button>
          );
        })}
    </div>
  );
}
