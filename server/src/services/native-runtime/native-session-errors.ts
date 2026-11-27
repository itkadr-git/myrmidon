export class NativeCancellationPendingRecoveryError extends Error {
  constructor() {
    super("native_cancellation_pending_recovery");
    this.name = "NativeCancellationPendingRecoveryError";
  }
}

export class NativeControllerDetachedForRestartError extends Error {
  constructor() {
    super("native_controller_detached_for_restart");
    this.name = "NativeControllerDetachedForRestartError";
  }
}