import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BudgetedInference, type ChatBody } from '../inference-gateway.ts';
import { StagedWork } from '../staging.ts';
import { DEFAULT_UTILITIES } from '../state.ts';
const executable = fileURLToPath(new URL(`../../research/dist/local-agent-research/local-agent-research${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
class FixtureInference extends BudgetedInference {
  seen: string[] = []; goals: (string | undefined)[] = []; abortAfter?: number; controller?: AbortController;
  constructor() { super({ requestJson: async <T>() => ({} as T), requestStream: async () => new Response(), restartLowerProfile: async () => ({ contextTokens: 8192, outputTokens: 1024 }) }, { model: 'fixture', contextTokens: 8192, outputTokens: 1024 }); }
  async count(body: ChatBody) { return JSON.stringify(body.messages).length / 4; }
  async summarize(text: string, _signal?: AbortSignal, goal?: string) { this.seen.push(text); this.goals.push(goal); if (this.seen.length === this.abortAfter) this.controller?.abort(); return `Summary ${this.seen.length}: ${text.slice(-80)}`; }
}

class EvidenceInference extends FixtureInference {
  async summarize(text: string, _signal?: AbortSignal, goal?: string) {
    this.seen.push(text); this.goals.push(goal);
    const evidence = [...new Set(text.match(/CHUNK_\d{2}|TEXT_PAGE_\d+|OCR_UNAVAILABLE/g) ?? [])];
    if (text.includes('OCR is unsupported')) evidence.push('OCR_UNAVAILABLE');
    return `Evidence: ${[...new Set(evidence)].join(' ')}`;
  }
}

function mixedPdf(): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] /Count 7 >>',
  ];
  for (let page = 1; page <= 7; page++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${page >= 6 ? ` /Resources << /Font << /F1 10 0 R >> >> /Contents ${page === 6 ? 11 : 12} 0 R` : ''} >>`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const page of [6, 7]) {
    const content = `BT /F1 12 Tf 50 700 Td (TEXT_PAGE_${page}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let document = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
test('staged frozen file reads resume cursors, invalidate changed files, and cannot replay agent work', { skip: !existsSync(executable), timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-staging-')));
  const file = path.join(directory, 'source.txt');
  await writeFile(file, `START ${'long line '.repeat(700)} END_MARKER\n`);
  const controller = new AbortController(), inference = new FixtureInference(); inference.controller = controller; inference.abortAfter = 2;
  const stages: any[] = [];
  const options = { directory: path.join(directory, 'checkpoints'), executable, roots: [], files: [file], utilities: DEFAULT_UTILITIES, inference, signal: controller.signal, onStage: (stage: any) => stages.push(stage) };
  try {
    const paused = new StagedWork(options);
    await assert.rejects(paused.run('Summarize this source.', 'digest'), /stopped|abort|closed/i);
    const checkpoint = await paused.readCheckpoint(); assert.ok(checkpoint?.sources[0].cursor); assert.equal(checkpoint?.completed, 2);
    const resumedInference = new FixtureInference(); const resumed = new StagedWork({ ...options, inference: resumedInference, signal: new AbortController().signal });
    const context = await resumed.run('Summarize this source.', 'digest', true);
    assert.ok(context); assert.ok(resumedInference.seen.some(text => text.includes('END_MARKER')));
    assert.equal((await resumed.readCheckpoint())?.phase, 'ready');
    await writeFile(file, 'NEW_SOURCE_ONLY\n');
    const changedInference = new FixtureInference(); const changed = new StagedWork({ ...options, inference: changedInference, signal: new AbortController().signal });
    await changed.run('Summarize this source.', 'digest', true);
    assert.ok(changedInference.seen.some(text => text.includes('NEW_SOURCE_ONLY')));
    assert.ok(stages.some(stage => stage.stage === 'Restarting read stages'));
    await changed.mark('agent');
    await assert.rejects(changed.run('Summarize this source.', 'digest', true), /Only paused read-only stages/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('26 frozen file chunks retain evidence and task goals with bounded incremental summaries', { skip: !existsSync(executable), timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-staging-bounded-')));
  const file = path.join(directory, 'source.txt');
  // An 8K profile requests 1638 characters. Numbered-line prefix consumes3;
  // each 1635-character segment therefore continues at its own marker.
  const markers = Array.from({ length: 26 }, (_, index) => `CHUNK_${String(index + 1).padStart(2, '0')}`);
  await writeFile(file, markers.map(marker => `${marker} ${'x'.repeat(1635 - marker.length - 1)}`).join(''));
  const inference = new EvidenceInference();
  const task = 'Report every CHUNK_NN marker and preserve its source location.';
  const snapshots: { completed: number; summaries: string[]; phase: string }[] = [];
  const checkpointFile = path.join(directory, 'checkpoints', 'checkpoint.json');
  const staged = new StagedWork({ directory: path.dirname(checkpointFile), executable, roots: [], files: [file],
    utilities: DEFAULT_UTILITIES, inference, signal: new AbortController().signal,
    onStage: () => { if (existsSync(checkpointFile)) snapshots.push(JSON.parse(readFileSync(checkpointFile, 'utf8'))); } });
  try {
    const context = await staged.run(task, 'bounded-fixture-digest');
    const sourceCalls = inference.seen.filter(text => text.startsWith(`[${file} line`));
    assert.equal(sourceCalls.length, 26, 'Every source chunk must be processed exactly once.');
    assert.ok(inference.seen.length > sourceCalls.length, 'The task must actually combine summaries incrementally.');
    assert.ok(inference.goals.every(goal => goal === task), 'Both map and reduction stages must receive the current task.');
    for (let index = 0; index < markers.length; index++) {
      assert.ok(sourceCalls[index].includes(markers[index]));
      assert.ok(sourceCalls[index].includes(`column ${index * 1635 + 1}]`));
      assert.ok(context.includes(markers[index]), `Evidence ${markers[index]} cannot be lost during checkpoint reduction.`);
    }
    assert.ok(snapshots.filter(snapshot => snapshot.phase === 'reading').every(snapshot => snapshot.summaries.length < 8),
      'Checkpoint summary storage must remain bounded while all26 chunks are read.');
    assert.equal(snapshots.find(snapshot => snapshot.completed === 8)?.summaries.length, 4);
    const checkpoint = await staged.readCheckpoint();
    assert.equal(checkpoint?.completed, 26);
    assert.equal(checkpoint?.phase, 'ready');
    assert.equal(checkpoint?.sources[0].done, true);
    assert.equal(checkpoint?.sources[0].cursor, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mixed PDF staging explicitly marks OCR-only pages and continues to later text pages', { skip: !existsSync(executable), timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-staging-pdf-')));
  const file = path.join(directory, 'mixed.pdf');
  await writeFile(file, mixedPdf());
  const inference = new EvidenceInference();
  const task = 'Find the TEXT_PAGE markers, retaining physical page references and unreadable-page uncertainty.';
  const stages: { stage: string; message?: string }[] = [];
  const staged = new StagedWork({ directory: path.join(directory, 'checkpoints'), executable, roots: [], files: [file],
    utilities: DEFAULT_UTILITIES, inference, signal: new AbortController().signal, onStage: stage => stages.push(stage) });
  try {
    const context = await staged.run(task, 'pdf-fixture-digest');
    assert.ok(stages.some(stage => stage.stage === 'PDF page needs OCR' && stage.message?.includes('Continuing')));
    assert.ok(inference.seen.some(text => text.includes(`${file} page 1, character 0`) && text.includes('OCR is unsupported')));
    assert.ok(inference.seen.some(text => text.includes(`${file} page 6, character 0`) && text.includes('TEXT_PAGE_6')));
    assert.ok(inference.seen.some(text => text.includes(`${file} page 7, character 0`) && text.includes('TEXT_PAGE_7')));
    assert.ok(context.includes('OCR_UNAVAILABLE') && context.includes('TEXT_PAGE_6') && context.includes('TEXT_PAGE_7'));
    assert.ok(inference.goals.every(goal => goal === task));
    const checkpoint = await staged.readCheckpoint();
    assert.equal(checkpoint?.completed, 2);
    assert.equal(checkpoint?.phase, 'ready');
    assert.equal(checkpoint?.sources[0].done, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
