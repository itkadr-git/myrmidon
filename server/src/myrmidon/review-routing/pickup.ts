/** OPE-9676: serialize completion events before selecting the next review. */
export interface ReviewCandidate {
  id: string;
  updatedAt: Date;
  executionState: unknown;
}
export interface ReviewPickupPorts {
  serialize: (work: () => Promise<boolean>) => Promise<boolean>;
  hasWorkInFlight: () => Promise<boolean>;
  candidates: () => Promise<ReviewCandidate[]>;
  wake: (candidate: ReviewCandidate) => Promise<unknown>;
}
export async function pickupNextReview(
  ports: ReviewPickupPorts,
  options: { excludeIssueId?: string } = {},
): Promise<boolean> {
  return ports.serialize(async () => {
    // Re-read under the lock: concurrent completions must not each fill a slot.
    const candidates = (await ports.candidates())
      .filter((candidate) => candidate.id !== options.excludeIssueId)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id));
    const next = candidates[0];
    if (!next) return false;
    if (await ports.hasWorkInFlight()) return true;
    // A rejected admission is still review work: do not fall through to another
    // lane or skip FIFO. The periodic routing sweep can retry it.
    await ports.wake(next);
    return true;
  });
}
