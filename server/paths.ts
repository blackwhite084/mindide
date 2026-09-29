import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录（与启动时所在目录无关） */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录：默认 <项目>/data，可用 AI_MINDER_DATA 指定 */
export const DATA_DIR = resolve(process.env.AI_MINDER_DATA ?? resolve(ROOT, "data"));

export const WEB_DIST = resolve(ROOT, "web/dist");
