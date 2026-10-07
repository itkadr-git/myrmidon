"use strict";
// myrmidon(1.6.5 BOT-DISK-H2a): the error type shared by every myr-ws module
// (base, cli, open, restore, ...). exitCode is a MYR_WS_EXIT value (contract C2).

class MyrWsError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "MyrWsError";
    this.exitCode = exitCode;
  }
}

module.exports = { MyrWsError };
