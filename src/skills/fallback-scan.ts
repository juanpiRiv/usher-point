import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Fallback source used when the cwd has no .atl/skill-registry.md: scan each
 * SKILL.md under ~/.agents/skills (one level deep) and read their YAML
 * frontmatter (`name`, `description`) with a minimal line-based parser — no
 * YAML dependency.
 */

export interface ScannedSkill {
  name: string;
  description: string;
  path: string;
}

export function skillsRoot(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

export function scanFallbackSkills(root: string = skillsRoot()): ScannedSkill[] {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: ScannedSkill[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;

    const frontmatter = readFrontmatter(skillPath);
    const name = frontmatter["name"] ?? entry.name;
    const description = frontmatter["description"] ?? "";
    skills.push({ name, description, path: skillPath });
  }
  return skills;
}

function readFrontmatter(skillPath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(skillPath, "utf-8");
  } catch {
    return {};
  }

  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return {};

  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") break;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}
