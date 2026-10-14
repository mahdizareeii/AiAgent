import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantApprovalPolicy, hasApprovalPolicy, normalizeWorkspacePath, revokeApprovalPolicy, sanitizeApprovalPolicies } from '../approval-policies.ts';
import { LocalActions } from '../actions.ts';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('workspace approval policies normalize paths and remain utility-scoped', () => {
  const workspace = normalizeWorkspacePath('/tmp/free-local-agent/../project');
  let policies = grantApprovalPolicy([], workspace, 'fileEditing', '2026-10-13T00:00:00.000Z');
  policies = grantApprovalPolicy(policies, `${workspace}/.`, 'projectSearch', '2026-10-13T00:00:01.000Z');
  policies = grantApprovalPolicy(policies, workspace, 'fileEditing', '2026-10-13T00:00:02.000Z');
  assert.equal(policies.length, 2);
  assert.equal(hasApprovalPolicy(policies, workspace, 'fileEditing'), true);
  assert.equal(hasApprovalPolicy(policies, workspace, 'fileReading'), false);
  assert.equal(revokeApprovalPolicy(policies, workspace, 'fileEditing').length, 1);
  assert.equal(revokeApprovalPolicy(policies, workspace).length, 0);
});

test('malformed approval policy rows are dropped and paths are not widened', () => {
  const rows = sanitizeApprovalPolicies([{ workspacePath: '/tmp/project', utility: 'terminal', createdAt: 'x' }, { workspacePath: 'relative', utility: 'fileEditing', createdAt: 'x' }, { workspacePath: '/tmp/project', utility: 'fileReading', createdAt: 'x' }]);
  assert.deepEqual(rows, [{ workspacePath: normalizeWorkspacePath('/tmp/project'), utility: 'fileReading', createdAt: 'x' }]);
});

test('file mutations expose a workspace-scoped utility for the persistent policy', async () => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'local-agent-policy-action-')));
  await writeFile(path.join(workspace, 'note.txt'), 'before', 'utf8');
  let request: any;
  const actions = new LocalActions({ projectPath: workspace, historyDirectory: path.join(workspace, '.history'), onPermission: async value => { request = value; return true; } });
  const result = await actions.execute('edit_file', { path: 'note.txt', old_text: 'before', new_text: 'after' });
  assert.equal(result.isError, undefined);
  assert.equal(request.utility, 'fileEditing');
  assert.equal(request.workspacePath, workspace);
  assert.equal(request.alwaysApproveAllowed, true);
});

