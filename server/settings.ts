import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./paths.ts";
import type { ThinkingLevel } from "./types.ts";

/** 全局设置：模型、思考强度等，跨白板共享 */
export interface Settings {
  /** provider/id；为空时用 pi 的默认模型 */
  model?: string;
  thinking: ThinkingLevel;
}

const FILE = join(DATA_DIR, "settings.json");

export const settings: Settings = { thinking: "low" };

if (existsSync(FILE)) Object.assign(settings, JSON.parse(readFileSync(FILE, "utf8")));

export function saveSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(settings, null, 2));
}
