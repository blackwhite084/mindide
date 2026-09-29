import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type { Source } from "./types.ts";

const run = promisify(execFile);

/** 可以直接当文本读的扩展名（代码、配置、文档） */
const TEXT_EXT = new Set(
  (
    ".txt .md .markdown .mdx .rst .org .csv .tsv .json .jsonl .yaml .yml .toml .ini .cfg .conf .env .xml .html .htm .css .scss .less " +
    ".js .jsx .mjs .cjs .ts .tsx .vue .svelte .py .rb .go .rs .java .kt .kts .scala .swift .m .mm .c .h .cc .cpp .hpp .cs .php .lua " +
    ".sh .bash .zsh .fish .ps1 .sql .graphql .proto .gradle .dockerfile .makefile .cmake .r .jl .dart .ex .exs .erl .hs .clj .tf .log"
  ).split(" "),
);
const EXTRACT_EXT = new Set([".pdf", ".docx"]);
const TEXT_NAMES = new Set(["Dockerfile", "Makefile", "README", "LICENSE", ".gitignore", ".env.example"]);
/** 没有 rg 时，遍历目录要跳过的文件夹 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage", ".cache"]);

const MAX_FILE_BYTES = 2_000_000;
const READ_LIMIT_LINES = 200;
const READ_LIMIT_CHARS = 40_000;

export const isSupported = (name: string) => {
  const ext = extname(name).toLowerCase();
  return TEXT_EXT.has(ext) || EXTRACT_EXT.has(ext) || TEXT_NAMES.has(basename(name));
};

let rgAvailable: boolean | undefined;
async function hasRg() {
  if (rgAvailable === undefined) {
    rgAvailable = await run("rg", ["--version"]).then(
      () => true,
      () => false,
    );
  }
  return rgAvailable;
}

/** PDF / Word 转成文本；PDF 每页前加页码标记，方便引用 */
async function extractText(buf: Buffer, name: string): Promise<{ text: string; pages?: number }> {
  const ext = extname(name).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    // NFKC：PDF 常把汉字存成外形相同的康熙部首等兼容字符（如「⾦」），不规范化就搜不到「金」
    const pages = (text as string[]).map((t, i) => `--- 第 ${i + 1} 页 ---\n${t.normalize("NFKC").trim()}`);
    return { text: pages.join("\n\n"), pages: totalPages };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value.normalize("NFKC") };
  }
  return { text: buf.toString("utf8") };
}

/** 每块白板一个资料库：sources.json 记录清单，上传的文件存在 uploads/ 下 */
export class SourceLibrary {
  private sources: Source[] = [];
  private file: string;
  private uploads: string;
  /** 目录资料里 PDF / Word 的提取结果缓存 */
  private extracted = new Map<string, string>();
  onChange: (() => void) | undefined;

  constructor(private boardDir: string) {
    this.file = join(boardDir, "sources.json");
    this.uploads = join(boardDir, "uploads");
    if (existsSync(this.file)) this.sources = JSON.parse(readFileSync(this.file, "utf8"));
    // 上次没处理完的，重启后标记为出错，避免一直卡在“处理中”
    for (const s of this.sources) if (s.status === "processing") Object.assign(s, { status: "error", error: "处理被中断，请重新添加" });
  }

  list() {
    return this.sources;
  }

  get(idOrName: string) {
    return this.sources.find((s) => s.id === idOrName) ?? this.sources.find((s) => s.name === idOrName);
  }

  private save() {
    mkdirSync(this.boardDir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.sources, null, 2));
    this.onChange?.();
  }

  // ---------- 添加 / 删除 ----------

  async addUpload(name: string, buf: Buffer): Promise<Source> {
    const id = nanoid(8);
    mkdirSync(this.uploads, { recursive: true });
    const safe = basename(name).replace(/[^\w.\-一-龥]+/g, "_");
    const path = join(this.uploads, `${id}-${safe}`);
    writeFileSync(path, buf);
    const src: Source = { id, kind: "file", name: basename(name), path, size: buf.length, status: "processing", addedAt: Date.now() };
    this.sources.push(src);
    this.save();
    try {
      const { text, pages } = await extractText(buf, name);
      writeFileSync(`${path}.txt`, text);
      Object.assign(src, { status: "ready", pages });
      // 去掉页码标记后仍然没有文字：多半是扫描件或图片
      if (!text.replace(/^--- 第 \d+ 页 ---$/gm, "").trim()) {
        Object.assign(src, { status: "error", error: "没有提取到文字（可能是扫描件或图片）" });
      }
    } catch (err: any) {
      Object.assign(src, { status: "error", error: String(err?.message ?? err).slice(0, 200) });
    }
    this.save();
    return src;
  }

  async addDir(dirPath: string): Promise<Source> {
    const abs = resolve(dirPath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`目录不存在：${abs}`);
    const real = realpathSync(abs);
    const exists = this.sources.find((s) => s.kind === "dir" && s.path === real);
    if (exists) return exists;
    const src: Source = { id: nanoid(8), kind: "dir", name: basename(real), path: real, size: 0, status: "processing", addedAt: Date.now() };
    this.sources.push(src);
    this.save();
    try {
      const files = await this.listFiles(src);
      Object.assign(src, { status: "ready", files: files.length });
    } catch (err: any) {
      Object.assign(src, { status: "error", error: String(err?.message ?? err).slice(0, 200) });
    }
    this.save();
    return src;
  }

  remove(id: string) {
    const src = this.sources.find((s) => s.id === id);
    if (!src) return;
    if (src.kind === "file") {
      rmSync(src.path, { force: true });
      rmSync(`${src.path}.txt`, { force: true });
    }
    this.sources = this.sources.filter((s) => s.id !== id);
    this.save();
  }

  // ---------- 给 AI 用的只读访问 ----------

  /** 解析资料内的相对路径，不允许跳出资料根目录 */
  private within(src: Source, rel = ""): string {
    const abs = resolve(src.path, rel);
    if (abs !== src.path && !abs.startsWith(src.path + sep)) throw new Error("路径超出资料范围");
    const real = existsSync(abs) ? realpathSync(abs) : abs;
    if (real !== src.path && !real.startsWith(src.path + sep)) throw new Error("路径超出资料范围");
    return real;
  }

  /** 目录内的文本文件（相对路径），遵守 .gitignore */
  async listFiles(src: Source, sub = ""): Promise<string[]> {
    const root = this.within(src, sub);
    let files: string[];
    if (await hasRg()) {
      const { stdout } = await run("rg", ["--files", "--hidden", "-g", "!.git"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch(
        (e) => ({ stdout: e.stdout ?? "" }),
      );
      files = String(stdout).split("\n").filter(Boolean);
    } else {
      files = [];
      const walk = async (dir: string) => {
        for (const ent of await readdir(dir, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) await walk(join(dir, ent.name));
          } else files.push(relative(root, join(dir, ent.name)));
          if (files.length > 50_000) return;
        }
      };
      await walk(root);
    }
    const prefix = sub ? relative(src.path, root) : "";
    return files
      .filter(isSupported)
      .map((f) => (prefix ? join(prefix, f) : f))
      .sort();
  }

  /** 目录结构：按层级折叠成简短的树 */
  async tree(src: Source, sub = "", depth = 2): Promise<string> {
    if (src.kind !== "dir") return `${src.name}（单个文件，直接用 source_read 读取）`;
    const files = await this.listFiles(src, sub);
    const base = sub ? sub.replace(/\/$/, "") + "/" : "";
    const counts = new Map<string, number>();
    for (const f of files) {
      const rel = base && f.startsWith(base) ? f.slice(base.length) : f;
      const parts = rel.split("/");
      const key = parts.length > depth ? parts.slice(0, depth).join("/") + "/" : rel;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const lines = [...counts].slice(0, 400).map(([k, n]) => (k.endsWith("/") ? `${base}${k} (${n} 个文件)` : `${base}${k}`));
    return `${src.name}/${base}  共 ${files.length} 个文本文件\n${lines.join("\n")}${counts.size > 400 ? "\n…(更多已省略，请缩小 path)" : ""}`;
  }

  private async textOf(src: Source, rel?: string): Promise<{ text: string; label: string }> {
    if (src.kind === "file") return { text: readFileSync(`${src.path}.txt`, "utf8"), label: src.name };
    if (!rel) throw new Error("目录资料需要指定 path");
    const abs = this.within(src, rel);
    const st = await stat(abs);
    if (!st.isFile()) throw new Error(`不是文件：${rel}，可以用 source_tree 查看目录`);
    if (!isSupported(abs)) throw new Error(`不支持的文件类型：${rel}`);
    const ext = extname(abs).toLowerCase();
    if (EXTRACT_EXT.has(ext)) {
      const key = `${abs}:${st.mtimeMs}`;
      if (!this.extracted.has(key)) this.extracted.set(key, (await extractText(await readFile(abs), abs)).text);
      return { text: this.extracted.get(key)!, label: `${src.name}/${rel}` };
    }
    if (st.size > MAX_FILE_BYTES) throw new Error(`文件太大（${Math.round(st.size / 1024)}KB），请用 source_search 定位后再读`);
    return { text: await readFile(abs, "utf8"), label: `${src.name}/${rel}` };
  }

  /** 按行分段读取，带行号 */
  async read(src: Source, rel: string | undefined, offset = 1, limit = READ_LIMIT_LINES): Promise<string> {
    const { text, label } = await this.textOf(src, rel);
    const lines = text.split("\n");
    const start = Math.max(1, offset);
    const end = Math.min(lines.length, start + Math.min(limit, 600) - 1);
    let out = "";
    for (let i = start; i <= end; i++) {
      const line = `${String(i).padStart(5)}  ${lines[i - 1]}\n`;
      if (out.length + line.length > READ_LIMIT_CHARS) {
        out += `…(字数过多，已在第 ${i - 1} 行截断)\n`;
        return `${label}  第 ${start}-${i - 1} 行 / 共 ${lines.length} 行\n${out}`;
      }
      out += line;
    }
    const more = end < lines.length ? `\n（还有 ${lines.length - end} 行，用 offset=${end + 1} 继续读）` : "";
    return `${label}  第 ${start}-${end} 行 / 共 ${lines.length} 行\n${out}${more}`;
  }

  /** 全文搜索：返回 文件:行号: 内容 */
  async search(query: string, only?: Source, maxResults = 60): Promise<string> {
    const targets = only ? [only] : this.sources.filter((s) => s.status === "ready");
    const results: string[] = [];
    const needle = query.normalize("NFKC").toLowerCase();
    for (const src of targets) {
      if (results.length >= maxResults) break;
      if (src.kind === "dir" && (await hasRg())) {
        const { stdout } = await run(
          "rg",
          ["-n", "-S", "-F", "--no-heading", "--max-columns", "240", "--max-count", "8", "--hidden", "-g", "!.git", "--", query, "."],
          { cwd: src.path, maxBuffer: 16 * 1024 * 1024 },
        ).catch((e) => ({ stdout: e.stdout ?? "" }));
        for (const line of String(stdout).split("\n").filter(Boolean)) {
          const f = line.replace(/^\.\//, "").split(":")[0];
          if (!isSupported(f)) continue;
          results.push(`[${src.name}] ${line.replace(/^\.\//, "")}`);
          if (results.length >= maxResults) break;
        }
        continue;
      }
      const files = src.kind === "file" ? [undefined] : await this.listFiles(src);
      for (const f of files) {
        if (results.length >= maxResults) break;
        let text: string;
        try {
          text = (await this.textOf(src, f)).text;
        } catch {
          continue;
        }
        const lines = text.split("\n");
        let page: number | undefined;
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          const m = lines[i].match(/^--- 第 (\d+) 页 ---$/);
          if (m) page = Number(m[1]);
          if (!lines[i].toLowerCase().includes(needle)) continue;
          const where = f ?? (page ? `第 ${page} 页` : "");
          results.push(`[${src.name}] ${where}${where ? ":" : ""}${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        }
      }
    }
    if (!results.length) return `没有找到「${query}」`;
    return results.join("\n") + (results.length >= maxResults ? "\n…(结果较多，请换更具体的关键词)" : "");
  }

  /** 给模型看的资料清单 */
  outline() {
    const ready = this.sources.filter((s) => s.status === "ready");
    if (!ready.length) return "";
    return ready
      .map((s) =>
        s.kind === "dir"
          ? `- [${s.id}] 目录「${s.name}」 ${s.files ?? 0} 个文本文件`
          : `- [${s.id}] 文件「${s.name}」${s.pages ? ` ${s.pages} 页` : ` ${Math.round(s.size / 1024)}KB`}`,
      )
      .join("\n");
  }
}
