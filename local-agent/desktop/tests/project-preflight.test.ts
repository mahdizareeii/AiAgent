import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  activateSkills,
  detectProjectTypes,
  discoverSkills,
  hashText,
  parseSkillMetadata,
  PREFLIGHT_LIMITS,
  runProjectPreflight,
  selectSkills,
  validateSkillFile,
} from '../project-preflight.ts';

const skill = (name: string, description: string, body = 'Follow the local project conventions.'): string => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  source: fixture\n---\n${body}\n`;

test('Agent Skills metadata is parsed, bounded, and hashed without leaking frontmatter into instructions', () => {
  const source = skill('typescript-testing', 'Write and verify TypeScript tests.', 'Use the project test runner.');
  const parsed = parseSkillMetadata(source, '/workspace/.agents/skills/typescript-testing');
  assert.equal(parsed.name, 'typescript-testing');
  assert.equal(parsed.description, 'Write and verify TypeScript tests.');
  assert.deepEqual(parsed.metadata, { source: 'fixture' });
  assert.equal(parsed.hash, hashText(source));
  assert.ok(parsed.bodyOffset > 0);
  assert.equal(parsed.bodyBytes, Buffer.byteLength('Use the project test runner.\n'));
  for (const invalid of [
    '---\nname: Bad_Name\ndescription: invalid\n---\nbody',
    '---\nname: valid\ndescription:\n---\nbody',
    '---\nname: valid\ndescription: invalid\nunknown: nope\n---\nbody',
  ]) assert.throws(() => parseSkillMetadata(invalid), /Skill|frontmatter/);
  const advisory = parseSkillMetadata('---\nname: advisory\ndescription: Advisory tools only.\nallowed-tools: read_file\n---\nbody\n');
  assert.equal(advisory.allowedTools, 'read_file');
});

test('project skill discovery rejects unsafe paths, deduplicates by precedence, and enforces body limits', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'preflight-discovery-'));
  const bundled = await mkdtemp(path.join(tmpdir(), 'preflight-bundled-'));
  try {
    const localDir = path.join(workspace, '.agents/skills/release-check');
    const localOversized = path.join(workspace, '.agents/skills/oversized');
    const bundledDir = path.join(bundled, 'release-check');
    await mkdir(localDir, { recursive: true });
    await mkdir(localOversized, { recursive: true });
    await mkdir(bundledDir, { recursive: true });
    await writeFile(path.join(localDir, 'SKILL.md'), skill('release-check', 'Check release tasks locally.', 'LOCAL INSTRUCTIONS'));
    await writeFile(path.join(bundledDir, 'SKILL.md'), skill('release-check', 'Bundled fallback.', 'BUNDLED INSTRUCTIONS'));
    await writeFile(path.join(localOversized, 'SKILL.md'), skill('oversized', 'Too large.', 'x'.repeat(25 * 1024)));
    const outside = await mkdtemp(path.join(tmpdir(), 'preflight-outside-'));
    const outsideSkill = path.join(outside, 'escape');
    await mkdir(outsideSkill, { recursive: true });
    await writeFile(path.join(outsideSkill, 'SKILL.md'), skill('escape', 'Should never be followed.'));
    await symlink(outsideSkill, path.join(workspace, '.agents/skills/escape'));
    const skills = await discoverSkills({ workspacePath: workspace, bundledSkillDirectories: [bundled] });
    assert.deepEqual(skills.map(item => item.name), ['release-check']);
    assert.equal(skills[0].source, 'project');
    assert.equal(skills[0].sourceLabel, '.agents/skills');
    assert.equal((await activateSkills(skills))[0].instructions, 'LOCAL INSTRUCTIONS');
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(bundled, { recursive: true, force: true });
  }
});

test('project detection reports polyglot evidence, web frameworks, and manifest hashes', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'preflight-types-'));
  try {
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ dependencies: { next: '^1', react: '^1' } }));
    await writeFile(path.join(workspace, 'package-lock.json'), '{}');
    await writeFile(path.join(workspace, 'Cargo.toml'), '[package]\nname="fixture"\n');
    await writeFile(path.join(workspace, 'Dockerfile'), 'FROM node:24\n');
    const types = await detectProjectTypes(workspace);
    assert.ok(types.some(item => item.type === 'node' && item.frameworks.includes('next')));
    assert.ok(types.some(item => item.type === 'rust'));
    assert.ok(types.some(item => item.type === 'container'));
    assert.ok(types.some(item => item.type === 'web'));
    const polyglot = types.find(item => item.type === 'polyglot');
    assert.ok(polyglot);
    assert.equal(polyglot?.fileHashes['package.json'], hashText(JSON.stringify({ dependencies: { next: '^1', react: '^1' } })));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('preflight activates only relevant skills, keeps research disabled by default, and exposes a bounded hook', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'preflight-run-'));
  try {
    await writeFile(path.join(workspace, 'pyproject.toml'), '[project]\nname="fixture"\n');
    const root = path.join(workspace, '.claude/skills');
    await mkdir(path.join(root, 'python-testing'), { recursive: true });
    await mkdir(path.join(root, 'unrelated'), { recursive: true });
    await writeFile(path.join(root, 'python-testing/SKILL.md'), skill('python-testing', 'Run Python tests and verify failures.', 'Run pytest and report evidence.'));
    await writeFile(path.join(root, 'unrelated/SKILL.md'), skill('unrelated', 'Manage unrelated release notes.', 'No activation expected.'));
    let called = false;
    const offline = await runProjectPreflight({ workspacePath: workspace, request: 'Fix the Python tests', webResearchEnabled: false, research: async () => { called = true; return []; } });
    assert.equal(called, false);
    assert.equal(offline.activatedSkills[0]?.name, 'python-testing');
    assert.equal(offline.selectedSkills[0]?.name, 'python-testing');
    assert.match(offline.context, /web research is disabled/i);
    assert.equal(offline.digest, offline.preflightDigest);
    const online = await runProjectPreflight({ workspacePath: workspace, request: 'Fix the Python tests', webResearchEnabled: true, research: async request => {
      assert.equal(request.maxSearches, 1); assert.equal(request.maxFetches, 2); assert.ok(request.allowedHosts.includes('agentskills.io'));
      return [{ url: 'https://agentskills.io/specification', title: 'Spec', summary: 'Use bounded discovery.' }];
    } });
    assert.equal(online.externalResearch.verified, true);
    assert.match(online.context, /agentskills\.io\/specification/);
    assert.ok(Buffer.byteLength(online.context, 'utf8') <= PREFLIGHT_LIMITS.maxContextBytes);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('skill selection is deterministic and cancellation stops the run before activation', async () => {
  const skills = [
    parseSkillMetadata(skill('python-testing', 'Test Python code.'), '/x/python-testing'),
    parseSkillMetadata(skill('docs', 'Write documentation.'), '/x/docs'),
  ];
  const projects = [{ type: 'python' as const, projectType: 'python' as const, score: 8, confidence: 'high' as const, files: ['pyproject.toml'], frameworks: [], reason: 'Python', fileHashes: {} }];
  assert.equal(selectSkills(skills, 'Fix Python tests', projects)[0].name, 'python-testing');
  const workspace = await mkdtemp(path.join(tmpdir(), 'preflight-cancel-'));
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runProjectPreflight({ workspacePath: workspace, request: 'task', signal: controller.signal }), /cancelled|aborted/i);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('created or edited skills can be validated with the same bounded host parser', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'preflight-validate-'));
  try {
    const file = path.join(workspace, '.agents/skills/new-skill/SKILL.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, skill('new-skill', 'A reusable project workflow.', 'Use the documented check and verify its result.'));
    const validated = await validateSkillFile(file, workspace);
    assert.equal(validated.name, 'new-skill');
    await writeFile(file, '---\nname: invalid_name\ndescription: bad\n---\nbody\n');
    await assert.rejects(validateSkillFile(file, workspace), /Skill name|invalid/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
