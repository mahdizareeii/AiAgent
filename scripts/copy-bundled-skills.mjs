import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Copy every bundled Agent Skill directory into the runtime asset directory.
 * Loader modules live beside these directories and are intentionally not copied.
 */
export async function copyBundledSkills(sourceDirectory = 'local-agent/desktop/skills', destinationDirectory = 'dist/skills') {
  await mkdir(destinationDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await cp(path.join(sourceDirectory, entry.name), path.join(destinationDirectory, entry.name), { recursive: true });
  }
}
