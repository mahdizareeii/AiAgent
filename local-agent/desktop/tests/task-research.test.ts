import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadTaskResearchSkill, taskResearchInstructions } from '../skills/task-research.ts';

const bundledSkills = fileURLToPath(new URL('../skills/', import.meta.url));
const tools = { fileReading: true, projectSearch: true, fileEditing: true, terminal: true, webResearch: false };

test('the shipped Task research skill loads from its source file and applies only in Agent/Research', async () => {
  const skill = await loadTaskResearchSkill(bundledSkills);
  assert.equal(skill.name, 'task-research');
  assert.equal(skill.sourcePath, path.join(bundledSkills, 'task-research', 'SKILL.md'));
  assert.ok(skill.instructions.length > 0);
  assert.ok(skill.description.length > 0);
  assert.ok(!skill.instructions.startsWith('---'), 'Discovery metadata must not enter the local model context.');
  for (const mode of ['coding', 'research'] as const) {
    const offline = taskResearchInstructions(skill, mode, tools, '2026-10-10');
    const online = taskResearchInstructions(skill, mode, { ...tools, webResearch: true }, '2026-10-10');
    assert.ok(offline.endsWith(skill.instructions));
    assert.ok(online.endsWith(skill.instructions));
    assert.match(offline, /Web research is OFF/);
    assert.match(online, /Web research is enabled/);
    assert.match(offline, /Current UTC date.*2026-10-10/);
  }
  assert.equal(taskResearchInstructions(skill, 'assistant', tools, '2026-10-10'), '');
  assert.match(taskResearchInstructions(skill, 'coding', tools, 'unexpected injected date'), /did not supply a retrieval date/);
  assert.doesNotMatch(taskResearchInstructions(skill, 'coding', tools, 'unexpected injected date'), /unexpected injected date/);
});

test('missing, malformed, or oversized bundled instructions fail before an agent can use a partial skill', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'free-local-agent-skill-'));
  try {
    await assert.rejects(loadTaskResearchSkill(directory), /bundled Task research skill could not be loaded/);
    await mkdir(path.join(directory, 'task-research'));
    const source = path.join(directory, 'task-research', 'SKILL.md');
    for (const contents of [
      '# Missing discovery metadata',
      '---\nname: another-skill\ndescription: Wrong skill\n---\nInstructions',
      '---\nname: task-research\ndescription: Empty\n---\n   ',
      'x'.repeat(8193),
    ]) {
      await writeFile(source, contents);
      await assert.rejects(loadTaskResearchSkill(directory), /bundled Task research skill could not be loaded/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
