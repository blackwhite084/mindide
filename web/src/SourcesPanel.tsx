import { useEffect, useRef, useState } from "react";
import type { Source } from "../../server/types.ts";
import { client, type ClientState } from "./client.ts";

/** 客户端判断：哪些文件可以作为资料上传（与服务端 isSupported 保持一致的宽松版本） */
export const SOURCE_ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.mdx,.csv,.json,.yaml,.yml,.toml,.ini,.xml,.html,.css,.scss,.js,.jsx,.mjs,.cjs,.ts,.tsx,.vue,.svelte," +
  ".py,.go,.rs,.java,.kt,.swift,.c,.h,.cc,.cpp,.hpp,.cs,.php,.rb,.lua,.dart,.sh,.sql,.graphql,.proto,.gradle,.log";

const exts = new Set(SOURCE_ACCEPT.split(","));
const isSourceFile = (name: string) => {
  const m = name.toLowerCase().match(/\.[^.]+$/);
  return m ? exts.has(m[0]) : /^(Dockerfile|Makefile|README|LICENSE)$/.test(name);
};

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function metaOf(s: Source) {
  if (s.status === "processing") return s.kind === "dir" ? "正在扫描…" : "正在提取文字…";
  if (s.status === "error") return s.error ?? "出错";
  if (s.kind === "dir") return `${s.files ?? 0} 个文本文件 · ${s.uploaded ? "上传的文件夹" : s.path}`;
  return [s.pages ? `${s.pages} 页` : "", kb(s.size)].filter(Boolean).join(" · ");
}

/** 选择本地目录：浏览服务端所在机器的文件夹（浏览器拿不到真实路径） */
function DirPicker({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState("");
  const [data, setData] = useState<{ path: string; parent: string | null; dirs: string[]; project: boolean; home: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (p?: string) => {
    setError("");
    const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(p ?? "")}`);
    const d = await res.json();
    if (!res.ok) return setError(d.error ?? "无法读取");
    setData(d);
    setPath(d.path);
  };
  useEffect(() => {
    load(localStorage.getItem("lastDir") ?? undefined).catch(() => load());
  }, []);

  const add = async () => {
    setBusy(true);
    localStorage.setItem("lastDir", data?.parent ?? path);
    client.send({ type: "sources:addDir", path });
    setBusy(false);
    onDone();
  };

  return (
    <div className="dir-picker">
      <div className="dir-path">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") load(path);
          }}
          placeholder="目录路径，例如 ~/projects/my-app"
        />
      </div>
      {error && <div className="dir-error">{error}</div>}
      {data && (
        <div className="dir-list nowheel">
          {data.parent && (
            <div className="dir-item up" onClick={() => load(data.parent!)}>
              ↰ 上一级
            </div>
          )}
          {data.dirs.map((d) => (
            <div key={d} className="dir-item" onClick={() => load(`${data.path}/${d}`)}>
              📁 {d}
            </div>
          ))}
          {!data.dirs.length && <div className="empty">没有子目录</div>}
        </div>
      )}
      <div className="rel-actions">
        {data?.project && <span className="muted dir-hint">看起来是个项目目录</span>}
        <button className="ghost" onClick={onDone}>
          取消
        </button>
        <button className="primary" disabled={!path || busy} onClick={add}>
          添加这个目录
        </button>
      </div>
    </div>
  );
}

/** 直接填写目录路径；下面列出用过的目录，一键添加 */
function DirQuickAdd({ state, onBrowse }: { state: ClientState; onBrowse: () => void }) {
  const [path, setPath] = useState("");
  const added = new Set(state.sources.filter((s) => s.kind === "dir").map((s) => s.path));
  const recent = state.recentDirs.filter((d) => !added.has(d.path));
  const add = (p: string) => {
    if (!p.trim()) return;
    client.send({ type: "sources:addDir", path: p.trim() });
    setPath("");
  };
  return (
    <div className="dir-quick">
      <div className="dir-quick-row">
        <input
          value={path}
          placeholder="粘贴本地目录路径，如 ~/projects/my-app"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") add(path);
          }}
        />
        <button className="primary" disabled={!path.trim()} onClick={() => add(path)}>
          添加
        </button>
        <button className="ghost" onClick={onBrowse} title="浏览本机文件夹">
          浏览…
        </button>
      </div>
      {recent.length > 0 && (
        <div className="recent-dirs">
          <div className="muted">最近使用</div>
          {recent.slice(0, 8).map((d) => (
            <div key={d.path} className="recent-dir" title={d.path}>
              <span className="recent-name" onClick={() => add(d.path)}>
                📁 {d.name} <span className="muted">{d.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              </span>
              <button className="icon ghost" title="从最近使用中移除" onClick={() => client.send({ type: "recentDirs:forget", path: d.path })}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SourcesPanel({ state }: { state: ClientState }) {
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState("");
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const upload = async (files: File[], folder?: string) => {
    if (!files.length) return;
    setMsg("上传中…");
    try {
      const { added, rejected } = await client.uploadSources(files, folder);
      setMsg(
        [added.length ? `已添加 ${added.length} 个文件` : "", rejected.length ? `不支持：${rejected.join("、")}` : ""]
          .filter(Boolean)
          .join("；"),
      );
    } catch (err: any) {
      setMsg(err?.message ?? String(err));
    }
    setTimeout(() => setMsg(""), 5000);
  };

  return (
    <div
      className={`sources ${over ? "over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        upload([...e.dataTransfer.files]);
      }}
    >
      <div className="sources-head">
        <span className="muted">AI 会按需查阅这里的资料，并在节点里注明出处</span>
        <div className="sources-actions">
          <button onClick={() => fileInput.current?.click()}>上传文件</button>
          <button onClick={() => folderInput.current?.click()} title="上传整个文件夹（如代码库），会跳过 node_modules、.git 等">
            上传文件夹
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={SOURCE_ACCEPT}
          hidden
          onChange={(e) => {
            upload([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          // @ts-expect-error 非标准属性：选择文件夹
          webkitdirectory=""
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            const folder = files[0]?.webkitRelativePath.split("/")[0];
            // 只传能读的文本文件，跳过依赖和构建产物
            const skip = /(^|\/)(node_modules|\.git|dist|build|\.next|target|__pycache__|\.venv|venv)(\/|$)/;
            const keep = files.filter((f) => !skip.test(f.webkitRelativePath) && isSourceFile(f.name));
            if (folder) upload(keep, folder);
            e.target.value = "";
          }}
        />
        {msg && <div className="sources-msg">{msg}</div>}
        <DirQuickAdd state={state} onBrowse={() => setPicking(!picking)} />
      </div>
      {picking && <DirPicker onDone={() => setPicking(false)} />}
      <div className="source-list">
        {state.sources.length === 0 && !picking && (
          <div className="empty">
            还没有资料。
            <br />
            可以上传 PDF、Word、TXT、Markdown、代码文件，
            <br />
            或在上面填一个本地目录（例如代码库）。也可以把文件拖到这里。
          </div>
        )}
        {state.sources.map((s) => (
          <div key={s.id} className={`source ${s.status}`}>
            <span className="source-icon">{s.kind === "dir" ? "📁" : s.name.toLowerCase().endsWith(".pdf") ? "📕" : "📄"}</span>
            <div className="source-body">
              <div className="source-name" title={s.path}>
                {s.name}
              </div>
              <div className="source-meta">{metaOf(s)}</div>
              {s.kind === "dir" && s.status === "ready" && (
                <label className="source-bash" title="允许 AI 在这个目录里执行查看类命令（git log、wc、ls、cat…）；会拦截明显的修改操作，但这不是安全隔离">
                  <input
                    type="checkbox"
                    checked={!!s.allowBash}
                    onChange={(e) => client.send({ type: "sources:bash", id: s.id, allow: e.target.checked })}
                  />
                  允许 AI 执行查看命令
                </label>
              )}
            </div>
            <button className="icon ghost" title="移除（不会删除本地目录里的文件）" onClick={() => client.send({ type: "sources:remove", id: s.id })}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
