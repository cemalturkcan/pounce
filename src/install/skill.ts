import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import skillText from "../../skills/pounce/SKILL.md" with { type: "text" };

export const SKILL = skillText;

export function installSkill(skillsDir: string) {
  const file = path.join(skillsDir, "pounce", "SKILL.md");
  if (existsSync(file) && readFileSync(file, "utf8") === SKILL) return { file, changed: false };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, SKILL);
  return { file, changed: true };
}
