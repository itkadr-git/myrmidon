// myrmidon(OPE-12796): "same tool failure repeated" detector for hermes_gateway runs.
//
// The gateway's tool.completed event carries `error` as a boolean, never the
// error text, so comparing error strings made every failed call of a tool look
// identical and any three failures in a row stopped the run. A repeat is now one
// and the same call (tool name + argument preview, + error text when the event
// has one) failing again after the model has seen the previous failure.

export const TOOL_FAILURE_REPEAT_LIMIT = 3;

type StartedCall = { preview: string; seq: number };

type LastFailure = {
  toolName: string;
  preview: string;
  /** Error text when the event carried one (string); null for a boolean flag. */
  errorText: string | null;
  count: number;
  /** Sequence number of the newest tool.completed that touched this streak. */
  completedSeq: number;
};

export type ToolFailureRepeatTracker = {
  started(toolName: string, preview: string): void;
  /**
   * Feed a tool.completed. `failed` is the adapter's toolHasError() verdict,
   * `errorText` the trimmed error string when the event had one, else null.
   * Returns the streak when the same call has now failed `count` times in a row.
   */
  completed(
    toolName: string,
    failed: boolean,
    errorText: string | null,
  ): { count: number; preview: string } | null;
};

export function createToolFailureRepeatTracker(): ToolFailureRepeatTracker {
  let seq = 0;
  // Same FIFO pairing as the adapter's tool previews: the wire has no call id.
  const queues = new Map<string, StartedCall[]>();
  let last: LastFailure | null = null;

  return {
    started(toolName, preview) {
      seq += 1;
      const queue = queues.get(toolName);
      const call = { preview, seq };
      if (queue) queue.push(call);
      else queues.set(toolName, [call]);
    },
    completed(toolName, failed, errorText) {
      seq += 1;
      const queue = queues.get(toolName);
      const call = queue?.shift();
      if (queue && queue.length === 0) queues.delete(toolName);
      if (!failed) {
        last = null;
        return null;
      }
      // No matching tool.started (e.g. reconnect mid-call): preview unknown, and
      // the call counts as started after the previous failure.
      const preview = call?.preview ?? "";
      const startSeq = call?.seq ?? seq;
      if (last && last.toolName === toolName) {
        const sameCall =
          last.preview === preview &&
          (last.errorText === null || errorText === null || last.errorText === errorText);
        if (sameCall) {
          const seenByModel = startSeq > last.completedSeq;
          last.completedSeq = seq;
          // A failure whose call started before the previous one completed ran
          // in the same model turn: the model had not seen that error yet.
          if (seenByModel) last.count += 1;
          return last.count >= TOOL_FAILURE_REPEAT_LIMIT ? { count: last.count, preview } : null;
        }
      }
      last = { toolName, preview, errorText, count: 1, completedSeq: seq };
      return null;
    },
  };
}
