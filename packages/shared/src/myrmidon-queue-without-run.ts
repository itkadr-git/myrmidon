/** Default age after which ready work without an agent run is noteworthy. */
export const DEFAULT_QUEUE_WITHOUT_RUN_THRESHOLD_SEC = 20 * 60;

/** Shared across role-specific detections to prevent repeat attention noise. */
export const QUEUE_WITHOUT_RUN_REPEAT_WINDOW_SEC = 60 * 60;