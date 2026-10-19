import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EIGHT_GB_PROTOCOL, EIGHT_GB_FIXTURES, EIGHT_GB_SUITE_DIGEST, EIGHT_GB_UNVERIFIED_COMBINATIONS, evaluateEightGBComparison } from './protocol.ts';
import { EIGHT_GB_ASSET_TEMPLATE_DIGEST } from './assets.ts';
import { eightGBFixture, localOnlyOracleExecutor, verifyEightGBFixture } from './oracles.ts';

async function readEvidence(file: string) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 ** 2) throw new Error('Evidence must be a regular local JSON file of at most16MiB.');
  const bytes = await readFile(file), after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Evidence changed while reading.');
  return JSON.parse(bytes.toString('utf8'));
}
/** Evidence-only entry point. It cannot download, load, fabricate or run a model. */
export async function runEightGBValidation(args: string[]) {
  if (args.length === 1 && args[0] === '--describe') return { protocol: EIGHT_GB_PROTOCOL, fixtures: EIGHT_GB_FIXTURES, suiteDigest: EIGHT_GB_SUITE_DIGEST, combinations: EIGHT_GB_UNVERIFIED_COMBINATIONS,
    assetTemplateDigest: EIGHT_GB_ASSET_TEMPLATE_DIGEST, executionAdapter: 'real-electron-macos-adapter-unexecuted', actual8GBExecution: 'not-performed' };
  if (args.length === 5 && args[0] === '--verify-fixture') return verifyEightGBFixture({ fixture: eightGBFixture(args[1], process.execPath, args[4]), workspace: path.resolve(args[2]), hiddenDirectory: path.resolve(args[3]), nodeExecutable: process.execPath, pythonExecutable: args[4], executor: localOnlyOracleExecutor });
  if (args.length !== 3 || args[0] !== '--evaluate') throw new Error('Use --describe, --evaluate REFERENCE.json CANDIDATE.json, or --verify-fixture ID WORKSPACE NEW_PRIVATE_ORACLE_DIRECTORY PYTHON. Model execution is not implemented.');
  return evaluateEightGBComparison(await readEvidence(path.resolve(args[1])), await readEvidence(path.resolve(args[2])));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const value = await runEightGBValidation(process.argv.slice(2)); console.log(JSON.stringify(value, null, 2)); if ('eligibleForIndependentSupportReview' in value && !value.eligibleForIndependentSupportReview || 'passed' in value && !value.passed) process.exitCode = 1; }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
