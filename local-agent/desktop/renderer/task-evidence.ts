import type { Mode, TaskOutcome } from './types';

export function showOutcome(mode: Mode, outcome: TaskOutcome) {
  return mode !== 'assistant' || outcome.status !== 'completed' || outcome.checks.length > 0;
}

/** Labels depend on saved host checks, never on the assistant's completion prose. */
export function outcomePresentation(outcome: TaskOutcome) {
  const passed = outcome.checks.filter(check => check.status === 'passed').length;
  const failed = outcome.checks.filter(check => check.status === 'failed').length;
  const unverified = outcome.checks.filter(check => check.status === 'unverified').length;
  const checksPassed = outcome.status === 'completed' && (outcome.verification === 'passed' || outcome.verification === undefined && passed > 0 && failed === 0 && unverified === 0);
  const title = outcome.status === 'cancelled' ? 'Task stopped' : outcome.status === 'timed-out' ? 'Task reached its time limit'
    : outcome.status === 'blocked' ? 'Task blocked' : outcome.verification === 'passed' && outcome.status === 'completed' ? 'Plan checks passed'
      : failed ? 'Checks need attention' : checksPassed ? 'Recorded checks passed'
      : outcome.status === 'completed' ? 'Task completed; review checks' : 'Task needs verification';
  return { title, checksPassed, passed, failed, unverified };
}
