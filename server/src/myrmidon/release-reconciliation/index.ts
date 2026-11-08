/**
 * STACK-UPDATES-B Release Reconciliation Module.
 *
 * Provides a service that periodically (e.g. daily) checks current system release
 * against the latest vendor GitHub tag/release. On divergence, it creates a draft
 * task (status: backlog) with change summary and release notes.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./github-client.js";
export * from "./service.js";
