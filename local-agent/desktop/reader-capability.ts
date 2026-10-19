import type { Attachment, Mode, UtilityPreferences } from './renderer/types.ts';

type ReadUtilities = Pick<UtilityPreferences, 'fileReading' | 'projectSearch' | 'webResearch'>;
/** Presence only, after host grant validation. This never creates a grant. */
export function hasReaderCapability(utilities: ReadUtilities, grantedRoots: readonly string[], grantedFiles: readonly string[]): boolean {
  return utilities.webResearch || utilities.fileReading && (grantedRoots.length > 0 || grantedFiles.length > 0)
    || utilities.projectSearch && grantedRoots.length > 0;
}

/** A plain chat already carries its original request verbatim; avoid creating
 * an artificial file grant just to make a no-scope reader process necessary. */
export function shouldPersistRequestFile(mode: Mode, utilities: Pick<UtilityPreferences, 'fileReading'>,
  projectPath: string | undefined, files: readonly Attachment[]): boolean {
  return utilities.fileReading && (mode !== 'assistant' || Boolean(projectPath) || files.length > 0);
}
