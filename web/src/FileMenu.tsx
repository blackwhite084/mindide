import { getNodesBounds, getViewportForBounds, useReactFlow } from "@xyflow/react";
import { toPng } from "html-to-image";
import { useEffect, useRef } from "react";
import { client } from "./client.ts";
import { download, fromJSON, fromMarkdown, pickFile, toJSON, toMarkdown, type Fragment } from "./io.ts";
import { ui } from "./ui.ts";

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

function boardName() {
  const root = [...client.state.nodes.values()].find((n) => !n.parentId && !n.draft);
  return (root?.title || "ai-minder").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
}

function contentNodes() {
  return [...client.state.nodes.values()].filter((n) => !n.draft);
}

/** 打开导入确认：JSON 可替换或合并；Markdown 合并到选中节点下或作为新主题 */
function confirmImport(frag: Fragment, name: string, kind: "json" | "md", selected: string[], at: { x: number; y: number }) {
  if (!frag.nodes.length) {
    ui.openMenu({ ...at, items: [{ title: "文件里没有可导入的内容" }] });
    return;
  }
  const send = (mode: "replace" | "merge", parentId: string | null = null) =>
    client.send({ type: "board:import", mode, name, parentId, nodes: frag.nodes, edges: frag.edges });
  const target = selected.length === 1 ? client.state.nodes.get(selected[0]) : undefined;
  ui.openMenu({
    ...at,
    items: [
      { title: `「${name}」· ${frag.nodes.length} 个节点${frag.edges.length ? ` · ${frag.edges.length} 条关系` : ""}` },
      ...(target ? [{ label: `挂到「${target.title || "选中节点"}」下`, onClick: () => send("merge", target.id) }] : []),
      { label: "作为新主题加入", onClick: () => send("merge") },
      ...(kind === "json"
        ? [{ sep: true } as const, { label: "替换当前白板", danger: true, hint: "会先自动存版本", onClick: () => send("replace") }]
        : []),
    ],
  });
}

async function importFile(file: File, selected: string[], at: { x: number; y: number }) {
  const text = await file.text();
  const name = file.name.replace(/\.[^.]+$/, "");
  try {
    if (/\.json$/i.test(file.name)) confirmImport(fromJSON(text), name, "json", selected, at);
    else confirmImport(fromMarkdown(text, name), name, "md", selected, at);
  } catch (err: any) {
    ui.openMenu({ ...at, items: [{ title: `无法导入：${err?.message ?? err}` }] });
  }
}

export function FileMenu({ selected }: { selected: string[] }) {
  const rf = useReactFlow();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const exportPng = async () => {
    const nodes = rf.getNodes();
    if (!nodes.length) return;
    const bounds = getNodesBounds(nodes);
    const pad = 60;
    const width = Math.min(8000, Math.ceil(bounds.width + pad * 2));
    const height = Math.min(8000, Math.ceil(bounds.height + pad * 2));
    const vp = getViewportForBounds(bounds, width, height, 0.2, 1, pad / Math.max(width, height));
    const el = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!el) return;
    const url = await toPng(el, {
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      width,
      height,
      pixelRatio: 2,
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
      // 导出图里不要交互按钮
      filter: (n) => !(n instanceof HTMLElement && (n.classList.contains("fold-btn") || n.classList.contains("icon"))),
    });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${boardName()}-${stamp()}.png`;
    a.click();
  };

  // 拖文件到画布上导入
  useEffect(() => {
    const stage = document.querySelector<HTMLElement>(".stage");
    if (!stage) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      stage.classList.add("dropping");
    };
    const leave = () => stage.classList.remove("dropping");
    const drop = (e: DragEvent) => {
      leave();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      importFile(file, selectedRef.current, { x: e.clientX, y: e.clientY });
    };
    stage.addEventListener("dragover", over);
    stage.addEventListener("dragleave", leave);
    stage.addEventListener("drop", drop);
    return () => {
      stage.removeEventListener("dragover", over);
      stage.removeEventListener("dragleave", leave);
      stage.removeEventListener("drop", drop);
    };
  }, []);

  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = { x: r.left, y: r.bottom + 6 };
    const empty = contentNodes().length === 0;
    ui.openMenu({
      ...at,
      items: [
        { title: "导出" },
        {
          label: "Markdown 大纲",
          hint: ".md",
          onClick: () =>
            !empty && download(`${boardName()}-${stamp()}.md`, toMarkdown(contentNodes(), [...client.state.edges.values()]), "text/markdown"),
        },
        {
          label: "完整数据",
          hint: ".json",
          onClick: () =>
            !empty && download(`${boardName()}-${stamp()}.json`, toJSON(contentNodes(), [...client.state.edges.values()]), "application/json"),
        },
        { label: "图片", hint: ".png", onClick: () => !empty && exportPng() },
        { sep: true },
        { title: "导入" },
        {
          label: "打开文件…",
          hint: "也可拖到画布",
          onClick: async () => {
            const file = await pickFile(".json,.md,.markdown,.txt");
            if (file) importFile(file, selected, at);
          },
        },
      ],
    });
  };

  return (
    <button className="ghost" onClick={open}>
      文件
    </button>
  );
}
