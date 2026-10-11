/** Exact app-owned messages, so untrusted tool output cannot stop a turn by resemblance. */
export const cancelledActionText = 'The action was cancelled before it completed.';
export const interruptedTurnText = 'This turn stopped after an interrupted action request. Completed actions are preserved. Send a new request to continue; no action will be automatically repeated.';
export const actionRequestAbortedText = 'The local action request was cancelled. No action will be automatically repeated.';
export const actionRequestTimeoutText = 'The local action request timed out. No action will be automatically repeated.';
export const actionResponseInterruptedText = 'The local action result could not be confirmed. This turn stopped to prevent repeating an action. Completed actions are preserved; send a new request to continue.';
export const commandTimeoutText = 'The command reached its approved time limit and was stopped. It may have completed some work. This turn stopped to prevent repeating it; send a new request to continue.';
export const commandTimeoutLimits = { minimum: 100, maximum: 600_000, default: 60_000 } as const;
export const actionRequestDeadlines = { normal: 15 * 60_000, command: 25 * 60_000 } as const;
