/** A repair attempt starts with the next effectful operation after an observed failed check. */
export class RepairBudget {
  private awaitingRepair = false;
  private attempts = 0;
  private seen = new Set<string>();
  failedCheck(): void { this.awaitingRepair = true; }
  beginAction(id: string): number {
    if (this.seen.has(id)) return this.attempts;
    this.seen.add(id);
    if (this.awaitingRepair) { this.awaitingRepair = false; this.attempts++; }
    if (this.attempts > 3) throw new Error('Repair limit reached after three repair attempts following failed checks. Completed actions are preserved. Send a new request with the observed blocker.');
    return this.attempts;
  }
}
