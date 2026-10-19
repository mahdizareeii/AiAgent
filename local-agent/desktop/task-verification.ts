import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ActionToolEvent, ActionResult } from './actions.ts';
import { COMMAND_EVIDENCE_SCOPE, commandEvidenceTitle } from './task-outcome.ts';
import { ReadbackReceiptScope, exactReadbackReport, MAX_READBACK_FILE_BYTES, type DeliveredReadback,
  type ReadbackBinding, type ReadbackTarget } from './readback-receipts.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BRIEF_BYTES = 64 * 1024;
const checkId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const safePath = z.string().min(1).max(1024).refine(value => !value.includes('\0') && !path.isAbsolute(value)
  && !value.split(/[\\/]/).some(part => part === '..') && value !== '.', 'Use a relative workspace file path.');
const base = { id: checkId, description: z.string().min(1).max(1200) };
const legacyCriterionSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('exact_file'), path: safePath, content: z.string().max(32 * 1024) }).strict(),
  z.object({ ...base, kind: z.literal('contains'), path: safePath, text: z.string().min(1).max(8192) }).strict(),
  z.object({ ...base, kind: z.literal('presence'), path: safePath }).strict(),
  z.object({ ...base, kind: z.literal('preserve_file'), path: safePath }).strict(),
  z.object({ ...base, kind: z.literal('absence'), path: safePath }).strict(),
  z.object({ ...base, kind: z.literal('command'), command: z.string().min(1).max(8192), cwd: z.string().max(1024).default('.'), paths: z.array(safePath).max(32).default([]) }).strict(),
  z.object({ ...base, kind: z.literal('manual') }).strict(),
]);
const readbackCriterionSchema = z.object({ ...base, kind: z.literal('readback_file'), path: safePath,
  exactCriterionId: checkId, report: z.literal('exact_utf8') }).strict();
const criterionSchema = z.discriminatedUnion('kind', [...legacyCriterionSchema.options, readbackCriterionSchema]);
const legacyTaskBriefSchema = z.object({ version: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  goal: z.string().min(1).max(2400), deliverables: z.array(safePath).max(20), criteria: z.array(legacyCriterionSchema).min(1).max(12) }).strict();
export const taskBriefSchema = z.union([legacyTaskBriefSchema, legacyTaskBriefSchema.extend({ version: z.literal(2),
  criteria: z.array(criterionSchema).min(1).max(12) }).strict()])
  .superRefine((brief, context) => {
    if (new Set(brief.criteria.map(item => item.id)).size !== brief.criteria.length) context.addIssue({ code: 'custom', message: 'Criterion IDs must be unique.' });
    if (Buffer.byteLength(JSON.stringify(brief)) > MAX_BRIEF_BYTES) context.addIssue({ code: 'custom', message: 'The task brief exceeds 64 KiB.' });
    for (const criterion of brief.criteria) if (criterion.kind === 'command') {
      if (criterion.command.includes('\0') || path.isAbsolute(criterion.cwd) || criterion.cwd.split(/[\\/]/).includes('..')) context.addIssue({ code: 'custom', message: 'Verification commands require a relative workspace cwd and no NUL bytes.' });
      if (!criterion.paths.length && !brief.deliverables.length && !brief.criteria.some(item => 'path' in item)) context.addIssue({ code: 'custom', message: 'A command criterion needs declared workspace input paths.' });
    }
    for (const criterion of brief.criteria) if (criterion.kind === 'readback_file') {
      const linked = brief.criteria.find(item => item.id === criterion.exactCriterionId);
      if (linked?.kind !== 'exact_file' || linked.path !== criterion.path || Buffer.byteLength(linked.content, 'utf8') > MAX_READBACK_FILE_BYTES) {
        context.addIssue({ code: 'custom', message: 'A bounded readback must link one exact_file criterion for the identical literal path.' });
      }
      if (brief.criteria.filter(item => item.kind === 'readback_file' && item.path === criterion.path).length !== 1) {
        context.addIssue({ code: 'custom', message: 'One explicit readback criterion per exact literal path is supported.' });
      }
    }
  });
export type TaskBrief = z.infer<typeof taskBriefSchema>;
export type TaskCriterion = TaskBrief['criteria'][number];
export const acceptanceCheckSchema = z.object({ id: z.string(), title: z.string(), purpose: z.literal('acceptance'), checkIds: z.array(checkId),
  status: z.enum(['passed', 'failed', 'unverified']), detail: z.string(), toolId: z.string().optional(),
  evidence: z.object({ operation: z.string(), path: z.string().optional(), sha256: z.string().optional(), actionId: z.string().optional(),
    complete: z.boolean().optional(), commandSha256: z.string().optional(), inputDigest: z.string().optional() }).strict().optional() }).strict();
export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** POSIX literal words only: no expansion, operators, globbing, comments, or shell evaluation. */
function literalCommandArgv(command: string): string[] | undefined {
  if (!command || /[\0\r\n]/.test(command)) return;
  const words: string[] = []; let word = '', active = false, quote = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") { if (char === "'") quote = ''; else word += char; continue; }
    if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '`') return;
      else if (char === '\\') {
        const next = command[++index]; if (next === undefined) return;
        word += /["\\$`]/.test(next) ? next : '\\' + next;
      } else word += char;
      continue;
    }
    if (/[ \t]/.test(char)) { if (active) { words.push(word); word = ''; active = false; } continue; }
    if (char === "'" || char === '"') { active = true; quote = char; continue; }
    if (char === '\\') { const next = command[++index]; if (next === undefined) return; active = true; word += next; continue; }
    if (/[;&|<>()[\]{}*?$`#~]/.test(char)) return;
    active = true; word += char;
  }
  if (quote) return;
  if (active) words.push(word);
  if (!words.length || !words[0] || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return;
  return words;
}

function scriptCommandPaths(command: string): string[] {
  const argv = literalCommandArgv(command);
  if (!argv || !/^(?:node(?:js)?|python(?:3(?:\.\d+)?)?)$/.test(path.basename(argv[0])) && !quotedAbsoluteScriptExecutor(command, argv)) return [];
  const args = argv.slice(1); while (args.length && /^(?:--test|--check|-u|-B)$/.test(args[0])) args.shift();
  return args.length === 1 && /\.(?:[cm]?js|[cm]?ts|py)$/.test(args[0]) && safePath.safeParse(args[0]).success ? args : [];
}

function quotedAbsoluteScriptExecutor(command: string, argv: string[]): boolean {
  // Packaged Electron can be the reviewed Node executor. Do not assume an app
  // identity: retain the exact human command and bind only its literal script.
  return /^['"]/.test(command.trimStart()) && path.isAbsolute(argv[0]) && argv.length === 2
    && /\.(?:[cm]?js|[cm]?ts|py)$/.test(argv[1]) && safePath.safeParse(argv[1]).success;
}

function ordinaryRequestedCommand(tail: string): string | undefined {
  // Mask quoted words before recognizing prose suffixes, so an argument such as
  // 'after implementation' cannot be mistaken for an instruction boundary.
  let quote = '', visible = '';
  for (let index = 0; index < tail.length; index++) {
    const char = tail[index];
    if (quote) {
      if (quote === '"' && char === '\\') { visible += '_'; if (++index < tail.length) visible += '_'; }
      else { if (char === quote) quote = ''; visible += '_'; }
    }
    else if (char === "'" || char === '"' || char === '`') { quote = char; visible += '_'; }
    else if (char === '\\') { visible += '_'; if (++index < tail.length) visible += '_'; }
    else visible += char;
  }
  const suffix = /[ \t]+(?:after (?:implementation|the (?:final|last) (?:edit|change))\b|to verify\b|to observe the failing test\b|before (?:finishing|you finish)\b)/i.exec(visible);
  const sentenceEnd = /[.!?](?=\s|$)/.exec(visible);
  const end = Math.min(suffix?.index ?? tail.length, sentenceEnd?.index ?? tail.length);
  let command = tail.slice(0, end).trim();
  if (/^`[^`\r\n]+`$/.test(command)) command = command.slice(1, -1);
  // An ordinary prose sentence can end after a simple Node/Python script.
  if (!suffix && /\.(?:[cm]?js|[cm]?ts|py)\.$/.test(command)) command = command.slice(0, -1);
  const argv = literalCommandArgv(command);
  if (!argv || !/^(?:node(?:js)?|python(?:3(?:\.\d+)?)?|pytest|npm|pnpm|yarn|cargo|go)$/.test(path.basename(argv[0])) && !quotedAbsoluteScriptExecutor(command, argv)) return;
  if (!suffix && !scriptCommandPaths(command).length) return;
  return command;
}

/** Only direct imperatives outside quoted/code examples can establish a command. */
function requestRunKinds(request: string): Map<number, 'required' | 'prohibited'> {
  const kinds = new Map<number, 'required' | 'prohibited'>(); let closing = '', fence = '', lineStart = 0;
  for (let index = 0; index < request.length; index++) {
    const char = request[index];
    if (char === '\n') { lineStart = index + 1; continue; }
    const marker = request.slice(index, index + 3), onFenceLine = request.slice(lineStart, index).trim() === '';
    if (fence) { if (marker === fence && onFenceLine) { fence = ''; index += 2; } continue; }
    if (!closing && onFenceLine && (marker === '```' || marker === '~~~')) { fence = marker; index += 2; continue; }
    if (closing) {
      if (char === '\\') index++;
      else if (char === closing) closing = '';
      continue;
    }
    if (char === '"' || char === '`' || char === '“') { closing = char === '“' ? '”' : char; continue; }
    if ((char === "'" || char === '‘') && !/[\p{L}\p{N}_]/u.test(request[index - 1] ?? '')) { closing = char === '‘' ? '’' : char; continue; }
    if (!/[rR]/.test(char) || /[A-Za-z0-9_]/.test(request[index - 1] ?? '') || !/^run[ \t]+/i.test(request.slice(index, index + 12))) continue;
    const clause = request.slice(Math.max(0, index - 240), index).split(/\n|[.!?;](?=\s|$)/).at(-1) ?? '';
    const prefix = clause.split(/\b(?:but|however|instead)\b/i).at(-1)!.trim();
    if (/\b(?:do[ \t]+not|don['’]?t|never|avoid|not[ \t]+allowed|must[ \t]+not|should[ \t]+not|cannot|can['’]t|may[ \t]+not)\b/i.test(prefix)) {
      kinds.set(index, 'prohibited'); continue;
    }
    if (/^(?:[-*][ \t]+|\d+[.)][ \t]+)?(?:(?:please|then|finally|also|now|first)[ \t]+)*$/i.test(prefix + (prefix ? ' ' : ''))
      || /\b(?:and|then|finally|please|also|must|should|now)[ \t]*$/i.test(prefix)
      || /\b(?:after implementation|after the (?:final|last) (?:edit|change)|once done|when done)[, \t]*$/i.test(prefix)) kinds.set(index, 'required');
  }
  return kinds;
}

function requestedCommandLiterals(request: string): { required: string[]; prohibited: string[] } {
  const kinds = requestRunKinds(request), required: string[] = [], prohibited: string[] = [];
  const add = (index: number, command?: string) => {
    const kind = kinds.get(index); if (!kind || !command) return;
    if (command.length > 8192 || command.includes('\0')) throw new Error('An explicit verification command exceeds the supported literal command bounds.');
    const commands = kind === 'required' ? required : prohibited;
    if (!commands.includes(command)) commands.push(command);
  };
  const expression = /\brun exactly[ \t]+(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([^\r\n]+?)[ \t]+to verify\b)/gi;
  for (const match of request.matchAll(expression)) add(match.index, match[1] ?? match[2] ?? match[3] ?? match[4]);
  for (const match of request.matchAll(/\brun[ \t]+(?!exactly\b)/gi)) {
    if (!kinds.has(match.index)) continue;
    const tail = request.slice(match.index + match[0].length).split(/[\r\n]/, 1)[0];
    add(match.index, ordinaryRequestedCommand(tail));
  }
  if (required.length > 12 || prohibited.length > 12) throw new Error('The request has more explicit verification commands than a frozen brief can represent.');
  return { required, prohibited };
}

/** Deliberately narrow literal grammar, taken only from the human request. */
export function requestedVerificationCommands(request: string): { command: string; paths: string[] }[] {
  return requestedCommandLiterals(request).required.map(command => ({ command, paths: scriptCommandPaths(command) }));
}

/** Explicit existing-script preservation only; pronouns are resolved in the same short clause. */
export function requestedProtectedInputs(request: string): string[] {
  const literal = '(?:`([^`\\r\\n]+)`|"([^"\\r\\n]+)"|\'([^\'\\r\\n]+)\'|([^ \\t\\r\\n]+))';
  const patterns = [new RegExp('\\b(?:preserve|keep)[ \\t]+' + literal + '[ \\t]+unchanged\\b', 'gi'),
    new RegExp('\\bread[ \\t]+' + literal + '[ \\t]+and[ \\t]+preserve[ \\t]+it[ \\t]+unchanged\\b', 'gi')];
  const files: string[] = [];
  for (const pattern of patterns) for (const match of request.matchAll(pattern)) {
    const file = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!file.includes('/') && !/\.[a-zA-Z0-9_-]+$/.test(file) && !/^(?:README|LICENSE|Makefile|Dockerfile)$/.test(file)) continue;
    safePath.parse(file); if (!files.includes(file)) files.push(file);
  }
  if (files.length > 12) throw new Error('More than 12 explicitly protected scripts exceeds the bounded preservation contract.');
  return files;
}

function validateRequestedCommands(brief: TaskBrief, request: string): void {
  const prohibited = requestedCommandLiterals(request).prohibited;
  for (const criterion of brief.criteria) if (criterion.kind === 'command') {
    const argv = literalCommandArgv(criterion.command);
    if (prohibited.some(command => command === criterion.command || argv && JSON.stringify(literalCommandArgv(command)) === JSON.stringify(argv))) {
      throw new Error('The task brief contains a verification command explicitly prohibited by the human request.');
    }
  }
  const requested = requestedVerificationCommands(request);
  for (const criterion of brief.criteria) if (criterion.kind === 'command' && criterion.cwd === '.' && !requested.some(item => item.command === criterion.command)) {
    const argv = literalCommandArgv(criterion.command);
    const matches = argv ? requested.filter(item => JSON.stringify(literalCommandArgv(item.command)) === JSON.stringify(argv)) : [];
    if (matches.length === 1) criterion.command = matches[0].command;
    else if (matches.length > 1) throw new Error('Ambiguous equivalent verification commands; preserve each exact human command literally.');
  }
  if (requested.length) for (const criterion of brief.criteria) if (criterion.kind === 'command'
    && !requested.some(item => item.command === criterion.command && criterion.cwd === '.')) {
    throw new Error(`Use only the human's exact verification commands: ${JSON.stringify(requested.map(item => item.command))}. Bind required behavior to them; do not invent extra mandatory shell probes or bonus checks: ${criterion.command}`);
  }
  for (const required of requested) {
    const criterion = brief.criteria.find(item => item.kind === 'command' && item.command === required.command && item.cwd === '.');
    if (!criterion || criterion.kind !== 'command') throw new Error(`Preserve the user's exact verification command as a command criterion with cwd '.': ${required.command}`);
    for (const file of required.paths) if (!criterion.paths.includes(file)) throw new Error(`The exact verification command must include its requested script in paths: ${file}`);
  }
  const protectedNames = requestedProtectedInputs(request).flatMap(file => file.split('/')).filter(file => /\.[a-zA-Z0-9_-]+$/.test(file));
  for (const criterion of brief.criteria) if (criterion.kind === 'manual' && /\bunchanged\b/i.test(criterion.description)
    && protectedNames.some(file => criterion.description.includes(file))) throw new Error('An explicitly protected file is a mechanical preservation requirement; use preserve_file with one exact path, not manual.');
}

/** Execution policy stays separate from the structural schema used to reopen historical outcomes. */
function validateFileCriteria(brief: TaskBrief): void {
  for (const criterion of brief.criteria) if (criterion.kind === 'absence') {
    const absent = /\b(?:absen\w*|missing|remov\w*|delet\w*|nonexistent|not exist|no longer|must not|should not|does not|do not|never)\b/i.test(criterion.description);
    if (!absent && /\b(?:exist\w*|present|creat\w*|implement\w*|produc\w*)\b/i.test(criterion.description)
      || brief.criteria.some(other => 'path' in other && other.path === criterion.path && other.kind !== 'absence')) {
      throw new Error(`Contradictory absence criterion for ${criterion.path}; use presence for an existing file and executable checks for its behavior.`);
    }
  }
}

/** Bounded literal request grammar: unsupported prose never invents byte expectations. */
export function requestedExactReadbacks(request: string): { path: string; content: string }[] {
  const legacy = /^(?:Please\s+)?(?:Create|Write|Update)\s+([^\s"'`]+)\s+(?:with|to contain)\s+exactly\s+(?:these\s+)?UTF-8\s+bytes(?:,\s*including the final LF newline)?\s*:\s*("(?:\\.|[^"\\\r\n])*")\s*\.?/i.exec(request);
  const finalLF = legacy ? null : /^(?:Please\s+)?(?:Create|Write|Update)\s+([^\s"'`]+)\s+(?:with|to contain)\s+exactly\s+the\s+UTF-8\s+bytes\s+of\s+("(?:\\.|[^"\\\r\n])*")\s+including\s+one\s+actual\s+final\s+LF\s*\.(?=\s|$)/i.exec(request);
  const create = legacy ?? finalLF;
  if (!create) return [];
  const tail = readbackDirectiveText(request.slice(create[0].length).trimStart()), file = create[1];
  if (!/(?:^|[.!?]\s+|\n)[ \t]*(?:Please\s+)?(?:Read it back and report (?:the )?(?:verified content|exact content|exact bytes)|Read the file and report its exact contents)\s*[.!?](?:\s|$)/i.test(tail)) return [];
  if (/(?:^|[.!?;]\s+|\n)[ \t]*(?:Please\s+)?(?:Create|Write|Update)\s+/i.test(tail)) throw new Error('Multiple literal file operations make this pronoun readback ambiguous. No task contract was frozen.');
  safePath.parse(file);
  const content: unknown = JSON.parse(create[2]);
  if (typeof content !== 'string' || Buffer.from(content, 'utf8').toString('utf8') !== content || content.includes('\0')
    || Buffer.byteLength(content, 'utf8') > MAX_READBACK_FILE_BYTES) throw new Error('This requested exact readback exceeds the bounded complete UTF-8 read/report contract.');
  // The suffix asserts the JSON bytes; it never authorizes adding a newline.
  if (finalLF && (!content.endsWith('\n') || /(?:\r?\n){2}$/.test(content))) throw new Error('The exact JSON bytes conflict with the requested single actual final LF. No task contract was frozen.');
  return [{ path: file, content }];
}

/** Bounded direct agent directives only; quoted examples, negation and human review are not obligations here. */
function readbackDirectiveText(request: string): string {
  let visible = '', quote = '', inlineTicks = 0, fenceCharacter = '', fenceLength = 0, lineStart = 0;
  const runEnd = (index: number, character: string) => { let end = index; while (request[end] === character) end++; return end; };
  for (let index = 0; index < request.length; index++) {
    const char = request[index], onFenceLine = request.slice(lineStart, index).trim() === '';
    if (char === '\n') { visible += '\n'; lineStart = index + 1; continue; }
    if (fenceLength) {
      if (onFenceLine && char === fenceCharacter) {
        const end = runEnd(index, char), lineEnd = request.indexOf('\n', end), suffix = request.slice(end, lineEnd < 0 ? request.length : lineEnd);
        if (end - index >= fenceLength && !suffix.trim()) {
          visible += '_'.repeat(end - index); index = end - 1; fenceCharacter = ''; fenceLength = 0; continue;
        }
      }
      visible += '_'; continue;
    }
    if (!quote && onFenceLine && (char === '`' || char === '~')) {
      const end = runEnd(index, char);
      if (end - index >= 3) { fenceCharacter = char; fenceLength = end - index; visible += '_'.repeat(fenceLength); index = end - 1; continue; }
    }
    if (quote === '`') {
      if (char === '`') { const end = runEnd(index, char); visible += '_'.repeat(end - index); if (end - index === inlineTicks) { quote = ''; inlineTicks = 0; } index = end - 1; }
      else visible += '_';
      continue;
    }
    if (quote) {
      visible += '_';
      if (char === '\\') { if (++index < request.length) visible += '_'; }
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '`') { const end = runEnd(index, char); quote = '`'; inlineTicks = end - index; visible += '_'.repeat(inlineTicks); index = end - 1; continue; }
    if (char === '"' || char === '“') { quote = char === '“' ? '”' : char; visible += '_'; continue; }
    if ((char === "'" || char === '‘') && !/[\p{L}\p{N}_]/u.test(request[index - 1] ?? '')) { quote = char === '‘' ? '’' : char; visible += '_'; continue; }
    visible += char;
  }
  // Recognized human-only/negative list headings govern the following bounded
  // paragraph. This protects explicit scopes without guessing arbitrary prose.
  let scoped = false;
  return visible.split('\n').map(line => {
    if (!line.trim()) { scoped = false; return line; }
    if (/^\s*(?:(?:A |The )?human(?: reviewer)? (?:must|should|will|is required to) (?:do|perform) the following|(?:Do not|Never|Don['’]t) (?:do|perform) (?:any of )?the following|(?:Human|Manual) review(?: instructions)?)\s*:\s*$/i.test(line)) scoped = true;
    return scoped ? line.replace(/[^\r]/g, '_') : line;
  }).join('\n');
}
function explicitAgentReadbackDirectiveCount(request: string): number {
  const visible = readbackDirectiveText(request);
  // This is an unsupported-requirement guard, not a parser that invents targets/content.
  return [...visible.matchAll(/(?:^|[.!?;]\s+|\n)[ \t]*(?:[-*][ \t]+|\d+[.)][ \t]+)?(?:(?:please|then|first|finally|also)[ \t]+)*read[ \t]+(?:it|(?:the[ \t]+)?(?:(?:written|created|updated|final|new)[ \t]+)?file|[\p{L}\p{N}_./-]+\.[\p{L}\p{N}_-]+|_+)[ \t]+(?:back\b|and[ \t]+(?:report|show|return)[ \t]+(?:(?:the|its)[ \t]+)?(?:(?:verified|exact)[ \t]+)?(?:content|contents|bytes)\b)/giu)].length;
}

function validateReadbackPlan(brief: TaskBrief, request: string, enabled: boolean): void {
  const rows = [...brief.criteria].filter((item): item is Extract<TaskCriterion, { kind: 'readback_file' }> => item.kind === 'readback_file');
  if (!enabled) {
    if (rows.length) throw new Error('Version2 readback criteria require the current explicit readback controller.');
    return;
  }
  const requested = requestedExactReadbacks(request), directiveCount = explicitAgentReadbackDirectiveCount(request);
  if (requested.length && directiveCount !== 1) throw new Error('Only one unambiguous explicit agent readback directive is supported. Preserve every requested readback and replan before actions; never silently drop a second file or repeated readback requirement.');
  if (!requested.length && directiveCount) throw new Error('The explicit agent readback/report requirement is unsupported or ambiguous. No contract was frozen: supply one literal relative UTF-8 file, exact JSON-escaped bytes, and an unambiguous readback/report directive; never silently omit the requirement or replace it with a manual pass.');
  if (rows.some(row => !requested.some(item => item.path === row.path))) throw new Error('The requested readback has no supported unambiguous literal user source; keep genuine human review manual and do not invent bytes.');
  for (const item of requested) {
    const exact = brief.criteria.find(row => row.kind === 'exact_file' && row.path === item.path && row.content === item.content);
    const escaped = item.path.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
    const routine = new RegExp('^(?:Verify (?:the )?content of ' + escaped + ' by )?(?:reading|read) it back and (?:reporting|report) (?:the )?exact bytes[.!]?$','i');
    if (brief.criteria.some(row => row.kind === 'manual' && routine.test(row.description.trim()))) {
      throw new Error('Routine agent readback/reporting is mechanical, not human review. Preserve the full user requirement and use version2 readback_file linked to the exact_file criterion; never delete the requirement or genuine human/subjective/manual review.');
    }
    if (!exact || !rows.some(row => row.path === item.path && row.exactCriterionId === exact.id)) {
      throw new Error('Preserve the explicit agent readback AND visible exact-content report with version2 readback_file {path,exactCriterionId,report:"exact_utf8"} linked to the exact user-provided bytes. An independent host exact_file check alone does not prove agent readback or reporting.');
    }
  }
}

export function parseTaskBrief(raw: unknown, request: string, options: { readbackProtocol?: boolean } = {}): TaskBrief {
  if (typeof raw === 'string') { if (Buffer.byteLength(raw) > MAX_BRIEF_BYTES) throw new Error('The task brief exceeds 64 KiB.'); raw = JSON.parse(raw); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The task brief must be a JSON object.');
  const supplied = raw as Record<string, unknown>, requestHash = hash(request);
  if (supplied.requestHash !== undefined && supplied.requestHash !== requestHash) throw new Error('The task brief belongs to a different request.');
  const brief = taskBriefSchema.parse({ ...supplied, version: supplied.version ?? 1, requestHash });
  validateFileCriteria(brief);
  validateRequestedCommands(brief, request);
  validateReadbackPlan(brief, request, options.readbackProtocol === true);
  return freeze(brief);
}

export function taskBriefInstructions(request: string, options: { readbackProtocol?: boolean } = {}): string {
  const readbacks = options.readbackProtocol ? requestedExactReadbacks(request) : [];
  const shape = readbacks.length
    ? 'version (the number 2 at the top level), goal (a string of at most 2400 characters preserving every user requirement), deliverables (relative file paths), criteria (1–12 flat objects with unique string id, description, kind, and only that kind\'s fields)'
    : 'goal (string preserving every user requirement), deliverables (relative file paths), criteria (1–12 objects with unique string id, description, kind, and only that kind\'s fields)';
  const reading = readbacks.length
    ? 'Keep routine reading/reporting instructions in goal. The supported explicit agent readback/report requirement additionally needs its own readback_file criterion linked to exact_file; never leave it only in goal or classify it as manual.'
    : 'Routine reading/reporting instructions belong in goal, not manual criteria.';
  const readbackKind = readbacks.length
    ? 'readback_file {path,exactCriterionId,report:"exact_utf8"} as a separate flat criterion for the explicit supported agent readback/report; exactCriterionId must be the linked exact_file criterion id for the identical literal path; ' : '';
  const example = readbacks.length ? { version: 2,
    goal: request.length <= 2400 ? request : 'FORMAT GUIDANCE ONLY: Replace this example goal with a summary of every CURRENT REQUEST requirement within 2400 characters. Preserve the complete original request and all necessary criteria.',
    deliverables: readbacks.map(item => item.path),
    criteria: readbacks.flatMap((item, index) => [
      { id: `exact-${index + 1}`, description: 'Match the literal user UTF-8 bytes', kind: 'exact_file', path: item.path, content: item.content },
      { id: `read-${index + 1}`, description: 'Actually read back and report the exact user bytes', kind: 'readback_file', path: item.path,
        exactCriterionId: `exact-${index + 1}`, report: 'exact_utf8' },
    ]) } : undefined;
  const format = example ? `\nFORMAT GUIDANCE ONLY: This example is not an accepted or frozen contract. Return a NEW JSON response preserving every CURRENT REQUEST requirement and all other necessary command, preservation, and genuine human-review criteria; extend the example when those are required. The example path/content come only from literal user source, never project evidence. Put "version":2 only at the top level. Each criterion must be flat with id, description, kind and only its kind fields. "readback_file" is only the kind value, never a key or nested object. Its exactCriterionId must equal the separate exact_file row's id. Keep genuine human/subjective/external review manual and unverified. Do not normalize malformed JSON or remove requirements.\nV2 FORMAT EXAMPLE:\n${JSON.stringify(example)}\nEND V2 FORMAT EXAMPLE\n` : '';
  return `Prepare a concise frozen coding contract. Return only JSON: ${shape}. No numeric IDs or extra keys. Use the fewest checks that prove all requirements. ${reading} Supported kinds: exact_file {path,content} for explicitly requested exact bytes; contains {path,text} for explicit literal text; presence {path} only when existence itself is required; absence {path} only when removal/nonexistence is required; preserve_file {path} for an existing file that must remain unchanged (one file per criterion; the host captures its initial digest); command {command,cwd:".",paths:["source and test files"]} for executable assertions; ${readbackKind}manual {} only for actual subjective human review or semantic requirements that cannot be tested mechanically. Never use absence for a file that must exist. Do not invent source bytes or replace behavior with existence. When verification commands are supplied below, use only those exact commands for mandatory executable criteria. Their descriptions should name the required behaviors they validate. Do not invent extra mandatory shell pipelines, probes or bonus checks. Preserve every behavior in goal; never auto-remove frozen criteria. Do not duplicate testable outputs, error handling or preservation as permanently unverified manual checks. Keep genuine human review manual. Include every relevant source/test input path, ordinary UTF-8 files at most 2 MiB each, not directories/globs. Preserve requested verification commands literally, including shell quotes, and include their scripts in paths. Never replace a requested check with ad hoc probes. Printing PASS is not validation. Expected-failure tests must assert exit status/stdout/stderr and exit zero only when correct; never mask failure with '|| true'. No tools or commands now.${format} Request hash: ${hash(request)}\nEXACT USER VERIFICATION COMMANDS:\n${JSON.stringify(requestedVerificationCommands(request))}\nCURRENT REQUEST:\n${request}`;
}

interface FileSnapshot { sha256: string | null; bytes: number; text?: string }

/** Numeric diagnostics from the same guarded snapshot; never expose either text. */
function exactFileMismatchDetail(expected: string, file: FileSnapshot): string | undefined {
  if (file.sha256 === null || file.text === undefined) return;
  // Buffer encoding replaces unpaired UTF-16 surrogates. Do not diagnose a
  // different, normalized expectation when the frozen literal is not scalar text.
  for (let index = 0; index < expected.length; index++) {
    const unit = expected.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = expected.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return;
  }
  const wanted = Buffer.from(expected, 'utf8'), actual = Buffer.from(file.text, 'utf8');
  if (actual.length !== file.bytes) return;
  let offset = 0;
  while (offset < wanted.length && offset < actual.length && wanted[offset] === actual[offset]) offset++;
  if (offset === wanted.length && offset === actual.length) return;
  const eof = offset === actual.length ? ': actual EOF' : offset === wanted.length ? ': expected EOF' : '';
  const missingFinalLF = wanted.length === actual.length + 1 && wanted[wanted.length - 1] === 0x0a && offset === actual.length;
  return `Exact UTF-8 mismatch: expected ${wanted.length} bytes; found ${actual.length}. First difference at byte ${offset} (zero-based)${eof}.`
    + (missingFinalLF ? ' The file matches the expected prefix and is missing exactly one final LF.' : '');
}

type InputSnapshot = Record<string, string | null>;
interface CommandRecord { actionId: string; revision: number; before: InputSnapshot; after?: InputSnapshot; passed: boolean; error?: string; commandSha256: string }

/** Uses only actual LocalActions callbacks and independent bounded filesystem reads. */
export class TaskVerificationLedger {
  readonly brief: TaskBrief;
  private revision = 0;
  private commands = new Map<string, CommandRecord>();
  private starts = new Map<string, { revision: number; snapshots: Map<string, InputSnapshot> }>();
  private pending: Promise<void> = Promise.resolve();
  private lastEvaluation?: { revision: number; checks: string; readbackRevision: number };
  private readbackRevision = 0;
  private readbackEffects = new Set<string>();
  private readbackScope?: ReadbackReceiptScope;
  private readbackReports = new Map<string, { nonce: string; revision: number; reportSha256: string; receipt: DeliveredReadback }>();
  private readbackReportTickets = new WeakMap<object, { records: DeliveredReadback[]; text: string; revision: number }>();
  private readbackFinalizations = new WeakMap<object, { revision: number; records: Map<string, DeliveredReadback>; cleanupReason: object }>();
  private readbackFinalizationIssued = false;
  private observedAction = false;
  private protectedInputs?: { path: string; id: string; sha256?: string; error?: string }[];
  private readonly workspacePath: string;
  constructor(brief: TaskBrief, workspacePath: string) {
    this.brief = freeze(taskBriefSchema.parse(brief));
    validateFileCriteria(this.brief);
    if (!path.isAbsolute(workspacePath)) throw new Error('Verification requires an absolute selected workspace.');
    this.workspacePath = workspacePath;
  }
  get verificationCheckIds(): string[] { return this.brief.criteria.filter(item => item.kind === 'command').map(item => item.id); }
  /** The original task signal is retained; a fresh caller signal cannot reopen a scope. */
  async bindReadbackScope(binding: ReadbackBinding, fileReading: boolean): Promise<ReadbackReceiptScope | undefined> {
    const targets: ReadbackTarget[] = this.brief.criteria.flatMap(criterion => {
      if (criterion.kind !== 'readback_file') return [];
      const exact = this.brief.criteria.find(item => item.id === criterion.exactCriterionId);
      if (exact?.kind !== 'exact_file' || exact.path !== criterion.path) throw new Error('A frozen readback link changed.');
      return [{ id: criterion.id, path: criterion.path, exactCriterionId: exact.id, content: exact.content, report: criterion.report }];
    });
    if (!targets.length) return;
    if (!fileReading) throw new Error('The requested agent readback requires enabled file reading. No tool or permission was granted.');
    if (this.readbackScope || binding.requestHash !== this.brief.requestHash || binding.workspacePath !== this.workspacePath || binding.signal.aborted) throw new Error('Readback scope must bind once to this exact current task.');
    this.readbackScope = await ReadbackReceiptScope.create({ ...binding, targets,
      currentRevision: () => this.readbackRevision, effectInFlight: () => this.readbackEffects.size > 0 });
    await this.readbackScope.start();
    return this.readbackScope;
  }
  /** Trusted LocalActions callback, BEFORE effects/approval; no status/operation inference. */
  recordReadbackEffect(event: { id: string; operation: string; phase: 'begin' | 'settled' }): void {
    if (event.phase === 'begin') this.readbackEffects.add(event.id);
    else this.readbackEffects.delete(event.id);
    this.readbackRevision++; this.readbackReports.clear(); this.readbackScope?.invalidate(); this.lastEvaluation = undefined;
  }
  async closeReadbackScope(): Promise<void> { await this.readbackScope?.close(); }
  private async currentReadback(id: string, signal?: AbortSignal, finalized?: ReadonlyMap<string, DeliveredReadback>): Promise<DeliveredReadback | undefined> {
    // Ordinary evaluation never revives a closed/aborted scope. Only the separate
    // one-shot intentional-drain token may carry already-published evidence.
    const receipt = this.readbackScope?.deliveredFor(id) ?? finalized?.get(id);
    if (!receipt || this.readbackEffects.size || this.readbackRevision !== receipt.revision) return;
    const criterion = this.brief.criteria.find(item => item.id === id);
    if (criterion?.kind !== 'readback_file') return;
    const exact = this.brief.criteria.find(item => item.id === criterion.exactCriterionId);
    if (exact?.kind !== 'exact_file') return;
    const current = await this.file(criterion.path, signal);
    const live = this.readbackScope?.deliveredFor(id);
    const published = this.readbackReports.get(id);
    const stillBound = live?.nonce === receipt.nonce
      || finalized?.get(id)?.nonce === receipt.nonce && published?.nonce === receipt.nonce && published.revision === receipt.revision;
    if (current.sha256 !== receipt.sha256 || current.bytes !== receipt.size || current.text !== receipt.text || current.text !== exact.content
      || this.readbackRevision !== receipt.revision || this.readbackEffects.size || !stillBound) return;
    return receipt;
  }
  /** No publication or reading tool is triggered automatically; freshness reads are verification only. */
  async prepareReadbackReport(signal?: AbortSignal): Promise<{ token: object; text: string } | undefined> {
    const records: DeliveredReadback[] = [];
    for (const criterion of this.brief.criteria) if (criterion.kind === 'readback_file') {
      const receipt = await this.currentReadback(criterion.id, signal);
      if (!receipt) return;
      const prior = this.readbackReports.get(criterion.id);
      if (!prior || prior.nonce !== receipt.nonce || prior.revision !== receipt.revision) records.push(receipt);
    }
    if (!records.length) return;
    const text = exactReadbackReport(records), token = Object.freeze({});
    this.readbackReportTickets.set(token, { records, text, revision: this.readbackRevision });
    return { token, text };
  }
  /** Call ONLY after an awaited durable user-facing writer; model text cannot supply this token. */
  async commitReadbackReport(token: object, publishedText: string, signal?: AbortSignal): Promise<void> {
    const candidate = this.readbackReportTickets.get(token); this.readbackReportTickets.delete(token);
    if (!candidate || this.readbackScope?.binding.signal.aborted || candidate.text !== publishedText || candidate.revision !== this.readbackRevision || this.readbackEffects.size) throw new Error('The readback report publication is stale or unbound.');
    for (const record of candidate.records) {
      const current = await this.currentReadback(record.criterionId, signal);
      if (!current || current.nonce !== record.nonce || current.revision !== candidate.revision) throw new Error('The file changed while publishing its readback report.');
    }
    signal?.throwIfAborted();
    if (this.readbackScope?.binding.signal.aborted || candidate.revision !== this.readbackRevision || this.readbackEffects.size
      || candidate.records.some(record => this.readbackScope?.deliveredFor(record.criterionId)?.nonce !== record.nonce)) {
      throw new Error('The readback report scope closed or changed before publication could commit.');
    }
    for (const record of candidate.records) this.readbackReports.set(record.criterionId,
      { nonce: record.nonce, revision: record.revision, reportSha256: hash(publishedText), receipt: Object.freeze({ ...record }) });
    this.lastEvaluation = undefined;
  }
  /** Capture synchronously from the exact latest healthy evaluation, BEFORE intentional cleanup. */
  prepareReadbackFinalization(checks: readonly AcceptanceCheck[]): { token: object; cleanupReason: object } | undefined {
    if (!this.readbackScope || this.readbackFinalizationIssued || this.readbackScope.binding.signal.aborted || this.readbackEffects.size
      || this.lastEvaluation?.revision !== this.revision || this.lastEvaluation.readbackRevision !== this.readbackRevision
      || this.lastEvaluation.checks !== JSON.stringify(checks)) return;
    const records = new Map<string, DeliveredReadback>();
    for (const criterion of this.brief.criteria) if (criterion.kind === 'readback_file') {
      const receipt = this.readbackScope.deliveredFor(criterion.id), report = this.readbackReports.get(criterion.id);
      if (!receipt || !report || report.nonce !== receipt.nonce || report.revision !== this.readbackRevision
        || !checks.some(check => check.id === 'acceptance:' + criterion.id && check.status === 'passed')) return;
      records.set(criterion.id, receipt);
    }
    if (!records.size) return;
    const token = Object.freeze({}), cleanupReason = Object.freeze({});
    this.readbackFinalizations.set(token, { revision: this.readbackRevision, records, cleanupReason }); this.readbackFinalizationIssued = true;
    return { token, cleanupReason };
  }
  /** Only the current owned normal cleanup reason can consume the token, once. */
  async evaluateReadbackFinalization(token: object, assertHealthy: () => void): Promise<AcceptanceCheck[]> {
    const finalization = this.readbackFinalizations.get(token); this.readbackFinalizations.delete(token);
    const valid = () => finalization && this.readbackScope?.binding.signal.aborted
      && this.readbackScope.binding.signal.reason === finalization.cleanupReason && this.readbackEffects.size === 0
      && finalization.revision === this.readbackRevision
      && [...finalization.records].every(([id, receipt]) => this.readbackReports.get(id)?.nonce === receipt.nonce);
    if (!valid()) throw new Error('The readback finalization token is closed, stale, or not bound to healthy owned cleanup.');
    assertHealthy();
    const checks = await this.evaluateChecks(undefined, finalization!.records);
    assertHealthy();
    if (!valid()) throw new Error('Readback evidence changed during final owned cleanup verification.');
    return checks;
  }
  /** Text guidance only; the frozen criteria and receipt requirements never change. */
  private commandVerificationGuidance(ids:readonly string[]=this.verificationCheckIds):string{
    const legacy='Legacy verification requires purpose "verification", nonempty matching checkIds and exact frozen command/cwd. Implementation command receipts do not satisfy acceptance.';
    if(!ids.length)return `No unresolved executable command criteria are listed; file/manual/preservation IDs cannot run commands. ${legacy}`;
    return `For frozen acceptance, call run_verification(${JSON.stringify({check_id:ids[0]})}) (example using one listed command ID; choose the criterion being verified). Allowed command check_ids: ${JSON.stringify(ids)}. The host supplies exact command/cwd and requests normal approval. ${legacy}`;
  }
  /** Must be awaited before any host action; model/workspace prose cannot set the expected digest. */
  async captureProtectedInputs(request: string, signal?: AbortSignal): Promise<void> {
    if (this.observedAction || this.protectedInputs) throw new Error('Protected inputs must be captured once, before the first host action.');
    if (hash(request) !== this.brief.requestHash) throw new Error('Protected inputs belong to a different request.');
    const usedIds = new Set(this.brief.criteria.map(criterion => criterion.id));
    const requested = [...new Set([...requestedProtectedInputs(request), ...this.brief.criteria.flatMap(criterion => criterion.kind === 'preserve_file' ? [criterion.path] : [])])];
    const makeInput = (file: string) => {
      const base = `host-preserve-${hash(file).slice(0, 16)}`; let id = base, suffix = 0;
      while (usedIds.has(id)) id = `${base}-${++suffix}`; usedIds.add(id);
      return { path: file, id };
    };
    this.protectedInputs = requested.map(makeInput);
    signal?.throwIfAborted();
    if (requested.length > 12) throw new Error('More than 12 protected existing files exceeds the bounded preservation contract.');
    const resolved: string[] = [];
    for (const file of requested) {
      const files = await this.resolveProtectedInput(file, signal);
      if (files.length > 1 && this.brief.criteria.some(criterion => criterion.kind === 'preserve_file' && criterion.path === file)) throw new Error('Each preserve_file criterion must name one existing file; split sibling shorthand into separate criteria.');
      for (const item of files) if (!resolved.includes(item)) resolved.push(item);
    }
    if (resolved.length > 12) throw new Error('More than 12 protected existing files exceeds the bounded preservation contract.');
    const initialInputs = new Map(this.protectedInputs.map(input => [input.path, input]));
    this.protectedInputs = resolved.map(file => initialInputs.get(file) ?? makeInput(file));
    for (const input of this.protectedInputs) {
      try {
        signal?.throwIfAborted(); const file = await this.file(input.path, signal);
        if (!file.sha256) throw new Error(`The explicitly protected existing script is missing: ${input.path}`);
        if (this.observedAction) throw new Error('A host action began while capturing protected inputs.');
        input.sha256 = file.sha256;
      } catch (error) { input.error = error instanceof Error ? error.message : String(error); throw error; }
    }
    this.lastEvaluation = undefined;
  }
  private async resolveProtectedInput(relative: string, signal?: AbortSignal): Promise<string[]> {
    safePath.parse(relative); signal?.throwIfAborted();
    const parts = relative.split('/');
    if (parts.length < 2) return [relative];
    // A real directory remains a nested path. Reinterpret the slash only when
    // the first component is independently proven to be an ordinary file, so
    // no nested destination could exist, and every sibling also exists safely.
    const root = await realpath(this.workspacePath);
    if (root !== path.resolve(this.workspacePath) || !(await lstat(root)).isDirectory()) throw new Error('The selected workspace changed.');
    let first;
    try { first = await lstat(path.join(root, parts[0])); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative]; throw error; }
    if (!first.isFile() || first.isSymbolicLink()) return [relative];
    if (parts.length > 12) throw new Error('More than 12 protected existing files exceeds the bounded preservation contract.');
    if (parts.some(part => !part || part === '.' || !/\.[a-zA-Z0-9_-]+$/.test(part))) throw new Error('Ambiguous protected-file slash shorthand; name each file separately.');
    for (const part of parts) if (!(await this.file(part, signal)).sha256) throw new Error(`The protected-file shorthand has a missing sibling: ${part}`);
    return parts;
  }
  preservationFailed(checks: readonly AcceptanceCheck[]): boolean {
    return Boolean(this.protectedInputs?.some(input => !input.sha256 || !checks.some(check => check.id === `acceptance:${input.id}` && check.purpose === 'acceptance'
      && check.checkIds.length === 1 && check.checkIds[0] === input.id && check.status === 'passed' && check.evidence?.operation === 'verify_preserved_file'
      && check.evidence.path === input.path && check.evidence.inputDigest === input.sha256 && check.evidence.sha256 === input.sha256 && check.evidence.complete === true)));
  }
  private dependencies(criterion: Extract<TaskCriterion, { kind: 'command' }>): string[] {
    return [...new Set([...criterion.paths, ...this.brief.deliverables, ...this.brief.criteria.flatMap(item => 'path' in item ? [item.path] : [])])].sort();
  }
  private async file(relative: string, signal?: AbortSignal): Promise<FileSnapshot> {
    signal?.throwIfAborted(); safePath.parse(relative);
    const root = await realpath(this.workspacePath);
    if (root !== path.resolve(this.workspacePath) || !(await lstat(root)).isDirectory()) throw new Error('The selected workspace changed.');
    const absolute = path.resolve(root, relative), location = path.relative(root, absolute);
    if (!location || location.startsWith(`..${path.sep}`) || path.isAbsolute(location)) throw new Error('Verification must stay inside the workspace.');
    let cursor = root;
    for (const component of location.split(path.sep)) {
      if (/^(?:\.git|\.ssh|\.aws|\.gnupg)$/i.test(component) || /^\.env(?:\.|$)/i.test(component)
        || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.|$)/i.test(component) || /\.(?:pem|key|p12|pfx)$/i.test(component)
        || /(?:^|[._-])(?:secrets?|tokens?|credentials|passwords?)(?:[._-]|$)/i.test(component)) throw new Error('Protected files cannot be used as verification inputs.');
      cursor = path.join(cursor, component);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Verification cannot follow symlinks.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sha256: null, bytes: 0 }; throw error; }
    }
    const descriptor = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await descriptor.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('Verification requires a regular file of at most 2 MiB.');
      const bytes = await descriptor.readFile(); const after = await descriptor.stat(); const current = await lstat(absolute);
      if (bytes.length > MAX_FILE_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs
        || await realpath(absolute) !== absolute || await realpath(this.workspacePath) !== root) throw new Error('The file changed during verification.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (bytes.includes(0) || /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) throw new Error('Verification requires ordinary UTF-8 project text.');
      signal?.throwIfAborted(); return { sha256: hash(bytes), bytes: bytes.length, text };
    } finally { await descriptor.close(); }
  }
  private async inputs(criterion: Extract<TaskCriterion, { kind: 'command' }>, signal?: AbortSignal): Promise<InputSnapshot> {
    const values: InputSnapshot = {}; for (const file of this.dependencies(criterion)) values[file] = (await this.file(file, signal)).sha256; return values;
  }
  async beforeVerificationCommand(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    if (args.purpose !== 'verification') return;
    const ids = Array.isArray(args.checkIds) ? args.checkIds as string[] : [];
    const snapshots = new Map<string, InputSnapshot>();
    for (const check of ids) {
      const criterion = this.brief.criteria.find(item => item.id === check);
      if (!criterion || criterion.kind !== 'command' || args.command !== criterion.command || (args.cwd ?? '.') !== criterion.cwd) throw new Error(`${this.commandVerificationGuidance()} No command ran: the supplied verification command/cwd must match its frozen command criteria and known nonempty checkIds.`);
      snapshots.set(check, await this.inputs(criterion, signal));
    }
    if (!snapshots.size) throw new Error(`${this.commandVerificationGuidance()} No command ran: verification needs known nonempty command criterion checkIds.`);
    this.starts.set(id, { revision: this.revision, snapshots });
  }
  recordHostAction(event: ActionToolEvent): void {
    this.observedAction = true;
    if (!['completed', 'failed'].includes(event.status)) return;
    // This host operation only reads retained output. A missing/malformed log
    // cannot invalidate a successful command against unchanged project inputs.
    if (event.title === 'Read command output') return;
    const result = event.output as ActionResult | undefined, receipt = result?.structuredContent;
    const args = event.input && typeof event.input === 'object' && !Array.isArray(event.input) ? event.input as Record<string, unknown> : {};
    if (event.title !== 'Run command') {
      if (receipt?.changed === true || event.status === 'failed' && result?.errorCode !== 'PERMISSION_DENIED') this.revision++;
      return;
    }
    if (args.purpose !== 'verification') { if (receipt?.operation === 'run_command') this.revision++; return; }
    const start = this.starts.get(event.id); this.starts.delete(event.id);
    if (!start) return;
    const ids = Array.isArray(args.checkIds) ? args.checkIds as string[] : [];
    const passed = event.status === 'completed' && result?.isError !== true && receipt?.ok === true && receipt.operation === 'run_command'
      && receipt.action_id === event.id && receipt.purpose === 'verification' && receipt.exit_code === 0 && receipt.exit_signal === null
      && receipt.command_sha256 === hash(String(args.command)) && JSON.stringify(receipt.check_ids) === JSON.stringify(ids);
    for (const id of ids) {
      const criterion = this.brief.criteria.find(item => item.id === id);
      const before = start.snapshots.get(id);
      if (!criterion || criterion.kind !== 'command' || !before) continue;
      const record: CommandRecord = { actionId: event.id, revision: start.revision, before, passed, commandSha256: hash(criterion.command),
        ...(!passed ? { error: 'The approved verification command did not return a host-confirmed successful exit.' } : {}) };
      this.commands.set(id, record);
      this.pending = this.pending.then(async () => { try { record.after = await this.inputs(criterion); } catch (error) { record.passed = false; record.error = String(error); } });
    }
  }
  async evaluate(signal?: AbortSignal): Promise<AcceptanceCheck[]> { return this.evaluateChecks(signal); }
  private async evaluateChecks(signal?: AbortSignal, finalized?: ReadonlyMap<string, DeliveredReadback>): Promise<AcceptanceCheck[]> {
    await this.pending; const checks: AcceptanceCheck[] = [];
    for (const criterion of this.brief.criteria) {
      signal?.throwIfAborted();
      const check: AcceptanceCheck = { id: `acceptance:${criterion.id}`, title: criterion.description, purpose: 'acceptance', checkIds: [criterion.id], status: 'unverified', detail: 'No current verification evidence is available.' };
      try {
        if (criterion.kind === 'manual') check.detail = 'This semantic requirement needs review; mechanical task completion is unverified.';
        else if (criterion.kind === 'readback_file') {
          const receipt = await this.currentReadback(criterion.id, signal, finalized), report = this.readbackReports.get(criterion.id);
          const passed = Boolean(receipt && report && report.nonce === receipt.nonce && report.revision === receipt.revision);
          check.status = passed ? 'passed' : 'unverified';
          check.detail = passed ? 'The authorized full UTF-8 file read was delivered to the local agent after the last effect; its exact escaped content report was durably published and the current bytes still match.'
            : 'This requires an actual complete current-turn read_file result delivered to the agent, unchanged current bytes, and a durably published exact-content report. A host byte check or model prose alone is insufficient.';
          if (passed && receipt && report) check.evidence = { operation: 'verify_readback_file', path: criterion.path,
            sha256: receipt.sha256, actionId: receipt.providerCallId, complete: true,
            inputDigest: hash(JSON.stringify({ nonce: receipt.nonce, revision: receipt.revision, reportSha256: report.reportSha256,
              requestHash: this.brief.requestHash, path: criterion.path, sha256: receipt.sha256 })) };
        }
        else if (criterion.kind === 'command') {
          const record = this.commands.get(criterion.id);
          if (record) {
            check.toolId = record.actionId;
            const current = await this.inputs(criterion, signal);
            const unchanged = record.revision === this.revision && record.after && JSON.stringify(record.before) === JSON.stringify(record.after) && JSON.stringify(record.after) === JSON.stringify(current);
            check.status = !record.passed ? 'failed' : unchanged ? 'passed' : 'unverified';
            check.detail = record.error ?? (unchanged ? 'The exact approved verification command exited zero and its declared inputs remain unchanged.' : 'Verification is stale: project changes or input digests changed after the command.');
            check.evidence = { operation: 'verify_command', actionId: record.actionId, commandSha256: record.commandSha256, inputDigest: hash(JSON.stringify(current)), complete: Boolean(unchanged) };
          }
        } else if (criterion.kind === 'preserve_file') {
          const initial = this.protectedInputs?.find(input => input.path === criterion.path);
          if (!initial?.sha256) check.detail = 'No trusted initial preservation digest was captured before actions.';
          else {
            const file = await this.file(criterion.path, signal), unchanged = file.sha256 === initial.sha256;
            check.status = unchanged ? 'passed' : 'failed';
            check.detail = unchanged ? 'The file matches its host-captured initial digest.' : 'The preserved file changed or disappeared.';
            check.evidence = { operation: 'verify_preserved_file', path: criterion.path, inputDigest: initial.sha256, ...(file.sha256 ? { sha256: file.sha256 } : {}), complete: true };
          }
        } else {
          const file = await this.file(criterion.path, signal);
          const passed = criterion.kind === 'absence' ? file.sha256 === null : file.sha256 !== null && (criterion.kind === 'presence' || (criterion.kind === 'exact_file' ? file.text === criterion.content : file.text!.includes(criterion.text)));
          check.status = passed ? 'passed' : 'failed';
          check.detail = passed ? 'The independent current workspace read satisfies the frozen file criterion.' : 'The current workspace file does not satisfy the frozen criterion.';
          if (!passed && criterion.kind === 'exact_file') check.detail = exactFileMismatchDetail(criterion.content, file) ?? check.detail;
          check.evidence = { operation: `verify_${criterion.kind}`, path: criterion.path, ...(file.sha256 ? { sha256: file.sha256 } : {}), complete: true };
        }
      } catch (error) { check.status = 'unverified'; check.detail = error instanceof Error ? error.message : String(error); }
      if (criterion.kind === 'command') {
        check.title = commandEvidenceTitle(check.status);
        check.detail = `${COMMAND_EVIDENCE_SCOPE}\n\n${check.detail}\n\nPlanned requirement (from the model; coverage unverified): ${criterion.description}`;
      }
      checks.push(check);
    }
    for (const input of this.protectedInputs ?? []) {
      const check: AcceptanceCheck = { id: `acceptance:${input.id}`, title: `Preserve existing script ${input.path} unchanged`, purpose: 'acceptance', checkIds: [input.id], status: 'unverified', detail: input.error ?? 'No trusted initial protected-input digest was captured.' };
      if (input.sha256) try {
        const current = await this.file(input.path, signal), unchanged = current.sha256 === input.sha256;
        check.status = unchanged ? 'passed' : 'failed'; check.detail = unchanged ? 'The explicitly protected script matches its host-captured initial digest.' : 'The explicitly protected script changed or disappeared after preparation.';
        check.evidence = { operation: 'verify_preserved_file', path: input.path, inputDigest: input.sha256, ...(current.sha256 ? { sha256: current.sha256 } : {}), complete: true };
      } catch (error) { check.detail = error instanceof Error ? error.message : String(error); }
      checks.push(check);
    }
    this.lastEvaluation = { revision: this.revision, readbackRevision: this.readbackRevision, checks: JSON.stringify(checks) };
    return freeze(checks);
  }
  canFinish(checks: AcceptanceCheck[]): boolean {
    return this.lastEvaluation?.revision === this.revision && this.lastEvaluation.checks === JSON.stringify(checks)
      && this.lastEvaluation.readbackRevision === this.readbackRevision && this.readbackEffects.size === 0
      && !this.preservationFailed(checks)
      && this.brief.criteria.every(criterion => checks.some(check => check.purpose === 'acceptance' && check.checkIds.length === 1 && check.checkIds[0] === criterion.id && check.id === `acceptance:${criterion.id}` && check.status === 'passed'));
  }
  missingChecksPrompt(checks: AcceptanceCheck[]): string {
    const missing = checks.filter(check => check.status !== 'passed');
    const commandIds=this.brief.criteria.filter(criterion=>criterion.kind==='command'&&missing.some(check=>check.checkIds.includes(criterion.id))).map(criterion=>criterion.id);
    return `The host has not verified every frozen acceptance criterion. Complete only the missing verification or repair observed failures. ${this.commandVerificationGuidance(commandIds)} Run missing acceptance verification after the final relevant edit. Do not repeat completed edits or implementation commands; commands and edits still require normal approvals. Explicitly protected existing scripts must remain unchanged. A failed host preservation check stops this task; do not weaken, recapture or replace its baseline. Manual semantic criteria remain unverified; report that limitation rather than inventing proof.\nFROZEN TASK BRIEF:\n${JSON.stringify(this.brief)}\nMISSING CHECKS:\n${JSON.stringify(missing)}`;
  }
}
