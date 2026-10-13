export const NORMAL_TASK_BUDGET_MS = 60 * 60_000;
export const MIN_TASK_BUDGET_MS = 1000;
export const MAX_TASK_BUDGET_MS = 8 * NORMAL_TASK_BUDGET_MS;
export type SSDTaskHours = 4 | 8;

/** Freeze this at turn preparation. A later preference cannot extend active work. */
export function executionBudgetMs(memoryMode: string, ssdTaskHours: SSDTaskHours = 4, retainedBudgetMs?: number): number {
  if (retainedBudgetMs !== undefined) {
    if (!Number.isSafeInteger(retainedBudgetMs) || retainedBudgetMs < MIN_TASK_BUDGET_MS || retainedBudgetMs > MAX_TASK_BUDGET_MS) {
      throw new Error('The saved task execution budget is invalid.');
    }
    return retainedBudgetMs;
  }
  if (ssdTaskHours !== 4 && ssdTaskHours !== 8) throw new Error('SSD tasks support four or eight active hours.');
  return memoryMode === 'ssd-experts' ? ssdTaskHours * NORMAL_TASK_BUDGET_MS : NORMAL_TASK_BUDGET_MS;
}

/** The active clock remains authoritative; this is the outer provider transport cap. */
export function providerTimeoutSeconds(budgetMs = NORMAL_TASK_BUDGET_MS): number {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < MIN_TASK_BUDGET_MS || budgetMs > MAX_TASK_BUDGET_MS) {
    throw new Error('The inference transport budget is invalid.');
  }
  return Math.max(1, Math.ceil(budgetMs / 1000));
}
