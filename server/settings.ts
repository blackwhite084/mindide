import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import type { ThinkingLevel } from "./types.ts";

/** 全局设置：模型、思考强度等，跨白板共享 */
export interface Settings {
  /** provider/id；为空时用 pi 的默认模型 */
  model?: string;
  thinking: ThinkingLevel;
  /** 用过的本地目录（以后做成多用户时按用户保存） */
  recentDirs: RecentDir[];
}

export interface RecentDir {
  path: string;
  name: string;
  lastUsed: number;
}

const FILE = join(DATA_DIR, "settings.json");

export const settings: Settings = { thinking: "low", recentDirs: [] };

if (existsSync(FILE)) Object.assign(settings, JSON.parse(readFileSync(FILE, "utf8")));

/** 记住一个目录，最近用的排前面，最多 20 个 */
export function rememberDir(path: string, name: string) {
  const rest = settings.recentDirs.filter((d) => d.path !== path);
  saveSettings({ recentDirs: [{ path, name, lastUsed: Date.now() }, ...rest].slice(0, 20) });
}

export function forgetDir(path: string) {
  saveSettings({ recentDirs: settings.recentDirs.filter((d) => d.path !== path) });
}

export function saveSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
}
