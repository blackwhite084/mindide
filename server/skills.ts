import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSkillsFromDir, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { DATA_DIR, ROOT } from "./paths.ts";
import type { SkillInfo } from "./types.ts";

/** 内置技能；用户自己的技能放在 <数据目录>/skills，同名时覆盖内置 */
const DIRS = [resolve(ROOT, "server/skills"), resolve(DATA_DIR, "skills")];

export interface LoadedSkill extends SkillInfo {
  body: string;
}

/** 每次都重新读取，改了 SKILL.md 不用重启 */
export function loadSkills(): LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>();
  for (const dir of DIRS) {
    if (!existsSync(dir)) continue;
    for (const s of loadSkillsFromDir({ dir, source: "ai-minder" }).skills) {
      try {
        byName.set(s.name, { name: s.name, description: s.description, body: stripFrontmatter(readFileSync(s.filePath, "utf8")).trim() });
      } catch {
        // 读不了就跳过
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const listSkills = (): SkillInfo[] => loadSkills().map(({ name, description }) => ({ name, description }));

export const findSkill = (name: string) => loadSkills().find((s) => s.name === name);

/** 技能正文，作为一段提示词注入 */
export const skillBlock = (s: LoadedSkill) => `<skill name="${s.name}">\n${s.body}\n</skill>`;

/** 放进 system prompt 的技能清单 */
export function skillsPrompt(): string {
  const skills = loadSkills();
  if (!skills.length) return "";
  return (
    "\n\n可用技能（一套固定的工作流程）：\n" +
    skills.map((s) => `- ${s.name}：${s.description}`).join("\n") +
    "\n用户消息里出现 <skill> 段落时，说明用户指定了这个技能，严格按它的流程工作。" +
    "用户没有指定、但需求明显符合某个技能时，先调用 use_skill 读取它再动手。"
  );
}

/** 解析输入开头的 /skill:name 命令 */
export function parseSkillCommand(text: string): { name: string; args: string } | null {
  const m = /^\/skill:([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}
