// Process-local counters and alarm gauge for scent classifier.
let scentClassifierAlarm = 0;
let scentAttempts = 0;
let scentSuccesses = 0;
let scentFailures = 0;

export const scentMetrics = {
  recordAttempt(ok: boolean): void {
    scentAttempts += 1;
    if (ok) {
      scentSuccesses += 1;
    } else {
      scentFailures += 1;
    }
  },
  setAlarm(alarm: boolean): void {
    scentClassifierAlarm = alarm ? 1 : 0;
  },
  isAlarm(): boolean {
    return scentClassifierAlarm === 1;
  },
  read() {
    return {
      alarm: scentClassifierAlarm,
      attempts: scentAttempts,
      successes: scentSuccesses,
      failures: scentFailures,
    };
  },
  reset(): void {
    scentClassifierAlarm = 0;
    scentAttempts = 0;
    scentSuccesses = 0;
    scentFailures = 0;
  },
};
