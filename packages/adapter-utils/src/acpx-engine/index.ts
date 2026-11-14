export * from "./constants.js";
export { createAcpxEngineExecutor, execute } from "./execute.js";
export { sessionCodec } from "./session-codec.js";
export { printAcpxStreamEvent } from "./cli.js";
export { parseAcpxStdoutLine } from "./ui.js";
// myrmidon(1.8 ACP / OPE-12942): the one bounded mapping from external job
// terminal callbacks to board execution state, with the idempotent registry.
export {
  mapTerminalCallback,
  TerminalCallbackRegistry,
} from "./terminal-callback-mapping.js";
export type {
  BoardTerminalState,
  MappedTerminalCallback,
  RecordedTerminalCallback,
  TerminalCallbackInput,
} from "./terminal-callback-mapping.js";
