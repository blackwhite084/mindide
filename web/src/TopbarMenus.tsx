import { useState } from "react";
import { client, type ClientState } from "./client.ts";
import { ui } from "./ui.ts";

/** 菜单里的单行输入表单（新建、重命名等） */
export function TextForm({
  title,
  initial = "",
  placeholder,
  confirm,
  danger,
  onSubmit,
  withInput = true,
  allowEmpty = false,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  confirm: string;
  danger?: boolean;
  withInput?: boolean;
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => {
    if (withInput && !allowEmpty && !value.trim()) return;
    ui.closeMenu();
    onSubmit(value.trim());
  };
  return (
    <div className="rel-form">
      <div className="ctx-title">{title}</div>
      {withInput && (
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") submit();
          }}
        />
      )}
      <div className="rel-actions">
        <button className="ghost" onClick={() => ui.closeMenu()}>
          取消
        </button>
        <button className={danger ? "danger" : "primary"} onClick={submit} autoFocus={!withInput}>
          {confirm}
        </button>
      </div>
    </div>
  );
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  return new Date(t).toLocaleDateString();
};

export function BoardSwitcher({ state }: { state: ClientState }) {
  const current = state.boards.find((b) => b.id === state.board);

  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = { x: r.left, y: r.bottom + 6 };
    const form = (node: React.ReactNode) => ui.openMenu({ ...at, items: [], form: node });
    ui.openMenu({
      ...at,
      items: [
        { title: "白板" },
        ...state.boards.map((b) => ({
          label: `${b.id === state.board ? "● " : ""}${b.name}`,
          hint: `${b.nodeCount} 节点 · ${ago(b.updatedAt)}`,
          onClick: () => b.id !== state.board && client.send({ type: "boards:switch", id: b.id }),
        })),
        { sep: true },
        {
          label: "新建白板",
          onClick: () =>
            form(
              <TextForm
                title="新建白板"
                placeholder="白板名称（可留空，稍后按主题自动命名）"
                confirm="创建"
                allowEmpty
                onSubmit={(name) => client.send({ type: "boards:create", name })}
              />,
            ),
        },
        ...(current
          ? [
              {
                label: "重命名当前白板",
                onClick: () =>
                  form(
                    <TextForm
                      title="重命名"
                      initial={current.name}
                      confirm="保存"
                      onSubmit={(name) => client.send({ type: "boards:rename", id: current.id, name })}
                    />,
                  ),
              },
              {
                label: "删除当前白板",
                danger: true,
                onClick: () =>
                  form(
                    <TextForm
                      title={`删除「${current.name}」？内容和版本历史都会删除，无法恢复（可先在「文件」里导出）。`}
                      confirm="删除"
                      danger
                      withInput={false}
                      onSubmit={() => client.send({ type: "boards:delete", id: current.id })}
                    />,
                  ),
              },
            ]
          : []),
      ],
    });
  };

  return (
    <button className="board-switch ghost" onClick={open} title="切换白板">
      {current?.name ?? "白板"} <span className="caret-down">▾</span>
    </button>
  );
}

/** 顶栏上显眼的「新白板」按钮 */
export function NewBoardButton() {
  return (
    <button
      className="ghost new-board"
      title="新建白板"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        ui.openMenu({
          x: r.left,
          y: r.bottom + 6,
          items: [],
          form: (
            <TextForm
              title="新建白板"
              placeholder="白板名称（可留空，稍后按主题自动命名）"
              confirm="创建"
              allowEmpty
              onSubmit={(name) => client.send({ type: "boards:create", name })}
            />
          ),
        });
      }}
    >
      ＋ 新白板
    </button>
  );
}

const THINKING: { level: ClientState["thinking"]; label: string }[] = [
  { level: "off", label: "不思考" },
  { level: "low", label: "少量思考" },
  { level: "medium", label: "中等思考" },
  { level: "high", label: "深度思考" },
];

const shortName = (name: string) => name.replace(/\s*\(latest\)/, "").replace(/^Claude\s+/, "");

export function ModelMenu({ state }: { state: ClientState }) {
  const current = state.models.find((m) => m.key === state.model);
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const byProvider = new Map<string, typeof state.models>();
    for (const m of state.models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
    ui.openMenu({
      x: r.left,
      y: r.bottom + 6,
      items: [
        ...[...byProvider].flatMap(([provider, list]) => [
          { title: provider },
          ...list.map((m) => ({
            label: `${m.key === state.model ? "● " : ""}${shortName(m.name)}`,
            hint: m.reasoning ? "推理" : "",
            onClick: () => client.send({ type: "model:set", key: m.key }),
          })),
        ]),
        ...(current?.reasoning
          ? [
              { sep: true } as const,
              { title: "思考强度（越高越慢）" },
              ...THINKING.map((t) => ({
                label: `${t.level === state.thinking ? "● " : ""}${t.label}`,
                onClick: () => client.send({ type: "thinking:set", level: t.level }),
              })),
            ]
          : []),
      ],
    });
  };
  if (!state.models.length) return null;
  return (
    <button className="ghost model-btn" onClick={open} title="切换模型">
      {current ? shortName(current.name) : "默认模型"}
      {current?.reasoning && state.thinking !== "off" && <span className="muted"> · {THINKING.find((t) => t.level === state.thinking)?.label}</span>}
      <span className="caret-down"> ▾</span>
    </button>
  );
}
