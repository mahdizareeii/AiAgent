import type { TaskOutcome } from './types';

/** Labels depend on saved host checks, never on the assistant's completion prose. */
export function outcomePresentation(outcome: TaskOutcome) {
  const passed = outcome.checks.filter(check => check.status === 'passed').length;
  const failed = outcome.checks.filter(check => check.status === 'failed').length;
  const unverified = outcome.checks.filter(check => check.status === 'unverified').length;
  const checksPassed = outcome.status === 'completed' && passed > 0 && failed === 0 && unverified === 0;
  const title = outcome.status === 'cancelled' ? 'Task stopped' : outcome.status === 'timed-out' ? 'Task reached its time limit'
    : outcome.status === 'blocked' ? 'Task blocked' : failed ? 'Checks need attention' : checksPassed ? 'Recorded checks passed'
      : outcome.status === 'completed' ? 'Task completed; review checks' : 'Task needs verification';
  return { title, checksPassed, passed, failed, unverified };
}
