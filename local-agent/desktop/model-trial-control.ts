/** A delayed UI cancellation may settle only the trial that owns this preflight. */
export function ownsTrialCancellation(requestedId: string, ownedPreflightId: string | undefined,
  current: { id: string; state: string } | null | undefined): boolean {
  return Boolean(ownedPreflightId && requestedId === ownedPreflightId && current?.id === requestedId
    && (current.state === 'loading' || current.state === 'calibrating'));
}
