import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { copyBundledSkills } from '../../../scripts/copy-bundled-skills.mjs';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const sourceRoot = path.join(repository, 'local-agent', 'desktop', 'skills');

function parseFrontmatter(source: string, directoryName: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  assert.ok(match, `${directoryName}/SKILL.md must contain YAML frontmatter and a body`);
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${directoryName} has an invalid Agent Skills name`);
  assert.equal(name, directoryName, `${directoryName} must match its frontmatter name`);
  assert.ok(name.length <= 64);
  assert.ok(description.length > 0 && description.length <= 1024);
  assert.ok(match[2].trim().length > 0);
}

test('all bundled skills use valid metadata and are copied into the runtime asset directory', async () => {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const skillDirectories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.ok(skillDirectories.includes('project-preflight'));
  assert.ok(skillDirectories.includes('task-research'));
  for (const directory of skillDirectories) {
    parseFrontmatter(await readFile(path.join(sourceRoot, directory, 'SKILL.md'), 'utf8'), directory);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'free-local-agent-skill-package-'));
  try {
    const destination = path.join(temporaryRoot, 'skills');
    await copyBundledSkills(sourceRoot, destination);
    for (const directory of skillDirectories) {
      const source = await readFile(path.join(sourceRoot, directory, 'SKILL.md'), 'utf8');
      const packaged = await readFile(path.join(destination, directory, 'SKILL.md'), 'utf8');
      assert.equal(packaged, source, `${directory}/SKILL.md was not copied byte-for-byte`);
      assert.ok((await stat(path.join(destination, directory))).isDirectory());
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
