import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { workspaceNameError } from './workspace-name.ts';

export interface WorkspaceSelection {
  /** Returns only the result of the native directory picker, never a renderer-supplied path. */
  pickDirectory: () => Promise<string | null>;
  assertAvailable: () => void;
  persistSelection: (canonicalFolder: string) => Promise<void>;
}

export async function persistWorkspaceSelection(folder: string, state: { projectPath?: string }, grants: Set<string>, save: () => Promise<void>): Promise<void> {
  const previous = state.projectPath;
  state.projectPath = folder;
  try { await save(); }
  catch (error) { state.projectPath = previous; throw error; }
  grants.add(folder);
}

async function canonicalDirectory(selected: string): Promise<string> {
  const canonical = await realpath(selected);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Choose a folder.');
  return canonical;
}

export async function selectWorkspaceFolder(selection: WorkspaceSelection): Promise<string | null> {
  selection.assertAvailable();
  const selected = await selection.pickDirectory();
  if (!selected) return null;
  selection.assertAvailable();
  const canonical = await canonicalDirectory(selected);
  if (canonical === path.parse(canonical).root) throw new Error('Choose a specific project folder.');
  selection.assertAvailable();
  await selection.persistSelection(canonical);
  return canonical;
}

export async function createWorkspaceFolder(name: string, selection: WorkspaceSelection): Promise<string | null> {
  selection.assertAvailable();
  const invalid = workspaceNameError(name);
  if (invalid) throw new Error(invalid);
  const selected = await selection.pickDirectory();
  if (!selected) return null;
  selection.assertAvailable();
  const parent = await canonicalDirectory(selected);
  const parentIdentity = await stat(parent);
  const target = path.join(parent, name);
  selection.assertAvailable();
  try { await mkdir(target, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A file or folder with that name already exists. Choose another name or use Add folder to open an existing folder.');
    }
    throw error;
  }
  // Never remove a created folder on failure: another process may already have
  // put content in it. Verify it before granting access, including parent races.
  try {
    const [currentParent, child, canonicalParent, canonicalChild] = await Promise.all([
      stat(parent), lstat(target), realpath(parent), realpath(target),
    ]);
    if (!child.isDirectory() || child.isSymbolicLink() || canonicalParent !== parent || canonicalChild !== target
      || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
      throw new Error('The selected folder changed while creating the workspace.');
    }
    selection.assertAvailable();
    await selection.persistSelection(canonicalChild);
    return canonicalChild;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Created folder ${JSON.stringify(target)}, but could not select it: ${reason} Your previous workspace is unchanged and no access was granted. The new folder was left untouched.`, { cause: error });
  }
}
