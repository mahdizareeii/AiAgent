import path from 'node:path';
import type { ApprovalPolicy, ApprovalUtility } from './renderer/types.ts';

export const APPROVAL_UTILITIES: readonly ApprovalUtility[] = ['fileReading', 'projectSearch', 'fileEditing'];

/** Normalize a workspace identity without following symlinks or touching disk. */
export function normalizeWorkspacePath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Approval policies require an absolute workspace path.');
  return path.normalize(path.resolve(value));
}

export function isApprovalUtility(value: unknown): value is ApprovalUtility {
  return typeof value === 'string' && (APPROVAL_UTILITIES as readonly string[]).includes(value);
}

export function sanitizeApprovalPolicies(value: unknown): ApprovalPolicy[] {
  if (!Array.isArray(value)) return [];
  const policies: ApprovalPolicy[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.workspacePath !== 'string' || !isApprovalUtility(row.utility) || typeof row.createdAt !== 'string') continue;
    try {
      const workspacePath = normalizeWorkspacePath(row.workspacePath);
      const key = `${workspacePath}\0${row.utility}`;
      if (seen.has(key)) continue;
      seen.add(key);
      policies.push({ workspacePath, utility: row.utility, createdAt: row.createdAt });
    } catch { /* malformed paths are dropped during migration */ }
    if (policies.length >= 512) break;
  }
  return policies;
}

export function hasApprovalPolicy(policies: readonly ApprovalPolicy[], workspacePath: string, utility: ApprovalUtility): boolean {
  let normalized: string;
  try { normalized = normalizeWorkspacePath(workspacePath); } catch { return false; }
  return policies.some(policy => policy.utility === utility && policy.workspacePath === normalized);
}

export function grantApprovalPolicy(policies: readonly ApprovalPolicy[], workspacePath: string, utility: ApprovalUtility, now = new Date().toISOString()): ApprovalPolicy[] {
  const normalized = normalizeWorkspacePath(workspacePath);
  const next = sanitizeApprovalPolicies(policies);
  if (!next.some(policy => policy.workspacePath === normalized && policy.utility === utility)) next.push({ workspacePath: normalized, utility, createdAt: now });
  return next;
}

export function revokeApprovalPolicy(policies: readonly ApprovalPolicy[], workspacePath: string, utility?: ApprovalUtility): ApprovalPolicy[] {
  const normalized = normalizeWorkspacePath(workspacePath);
  return sanitizeApprovalPolicies(policies).filter(policy => policy.workspacePath !== normalized || (utility !== undefined && policy.utility !== utility));
}

