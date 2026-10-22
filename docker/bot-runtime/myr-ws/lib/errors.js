"use strict";
// docker/bot-runtime/myr-ws/lib/errors.js
//
// myrmidon(1.6.5-BOT-DISK-H): the one error class of myr-ws. Same name and shape
// as MyrWsError in lib/base.js (H2a, #741): lib/cli.js maps `e.exitCode` of a
// MyrWsError to the process exit code (3 = disk quota), so every verb throws
// this class and nothing else.

class MyrWsError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "MyrWsError";
    this.exitCode = exitCode;
  }
}

module.exports = { MyrWsError };
