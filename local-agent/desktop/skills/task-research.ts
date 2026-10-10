import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Mode, UtilityPreferences } from '../renderer/types.ts';

export interface TaskResearchSkill {
  name: 'task-research';
  description: string;
  instructions: string;
  sourcePath: string;
}

// These are app-owned instructions, not Goose's externally discoverable skills.
// Keep a strict bound so a packaging mistake cannot overwhelm a small local model.
const maxSkillBytes = 8192;

export async function loadTaskResearchSkill(skillsDirectory: string): Promise<TaskResearchSkill> {
  const sourcePath = path.join(skillsDirectory, 'task-research', 'SKILL.md');
  try {
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > maxSkillBytes) throw new Error('Expected a bounded SKILL.md file.');
    const source = await readFile(sourcePath, 'utf8');
    if (Buffer.byteLength(source) > maxSkillBytes) throw new Error('SKILL.md exceeded its size limit.');
    const parsed = /^---\r?\nname: task-research\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(source);
    if (!parsed || !parsed[2].trim()) throw new Error('SKILL.md has invalid or missing instructions.');
    return { name: 'task-research', description: parsed[1].trim(), instructions: parsed[2].trim(), sourcePath };
  } catch (error) {
    throw new Error(`The bundled Task research skill could not be loaded. Rebuild or reinstall Free Local Agent. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function taskResearchInstructions(skill: TaskResearchSkill, mode: Mode, utilities: UtilityPreferences,
  currentDate?: string): string {
  if (mode !== 'coding' && mode !== 'research') return '';
  const date = currentDate && /^\d{4}-\d{2}-\d{2}$/.test(currentDate)
    ? `Current UTC date supplied by the app: ${currentDate}. Prefer fetched_at from tool results for retrieval dates.`
    : 'The app did not supply a retrieval date. Do not invent one.';
  const access = utilities.webResearch
    ? 'Web research is enabled for this turn. Use only the registered web_search and web_fetch tools for online research.'
    : 'Web research is OFF for this turn. Research local evidence, label current online facts unverified, and do not research online through terminal commands.';
  return `OPTIONAL PLUGIN: Task research\n${date}\n${access}\n${skill.instructions}`;
}
