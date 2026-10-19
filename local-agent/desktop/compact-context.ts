import { createHash } from 'node:crypto';
import { PORTABLE_CPU_PROFILE, type PortableCPUAllocationPlan } from '../runtime/portable-admission.ts';
import { inferenceProfileSignature, PINNED_ENGINE_COMMIT } from '../runtime/memory.ts';

const signature = inferenceProfileSignature(PORTABLE_CPU_PROFILE, 'low-memory');
/** Host-owned profile identity only; neither model prose nor a user flag opts in. */
export function usesCompactCPUContext(profile: { contextTokens: number; outputTokens: number; memoryMode?: string; profileSignature?: string; portableMemoryPlan?: PortableCPUAllocationPlan }): boolean {
  if (profile.contextTokens !== 4096 || profile.outputTokens !== 1024 || profile.memoryMode !== 'low-memory') return false;
  const plan = profile.portableMemoryPlan;
  if (!plan) return profile.profileSignature === signature;
  if (plan.kind !== 'portable-cpu-4k-v1' || plan.noAlloc !== true || plan.engineCommit !== PINNED_ENGINE_COMMIT || plan.profileSignature !== signature) return false;
  // Runtime admission enriches the geometry identity with the exact owned plan.
  // Never strip arbitrary fields or trust a digest supplied without that plan.
  const enriched = JSON.stringify({ ...JSON.parse(signature), portableMemoryPlanDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') });
  return profile.profileSignature === enriched;
}
