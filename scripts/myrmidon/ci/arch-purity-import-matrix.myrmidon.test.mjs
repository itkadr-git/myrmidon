import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { test } from "node:test";
import { checkDecisionLayerPurity } from "./arch-invariants-gate.mjs";

const domain = "server/src/modules/run-dispatch/domain";

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function withSandbox(fn) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), "cache/scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "arch-purity-"));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("INV-14 import matrix reports literal locations and resets on a clean scan", () => {
  withSandbox((root) => {
    write(root, `${domain}/matrix.ts`, [
      'import { db } from "@myrmidon/db";',
      'const dbAsync = import("@myrmidon/db");',
      'import { sql } from "drizzle-orm";',
      'const ormAsync = import("drizzle-orm");',
      'import fs from "node:fs";',
      'const fsAsync = import("node:fs");',
      'import net from "node:net";',
      'const netAsync = import("node:net");',
      'import http from "node:http";',
      'const httpAsync = import("node:http");',
      'import https from "node:https";',
      'const httpsAsync = import("node:https");',
      'import cp from "node:child_process";',
      'const cpAsync = import("node:child_process");',
      'import util from "node:util";',
      'const utilAsync = import("node:util");',
      'import { adapter } from "../adapters/postgres.js";',
      'const adapterAsync = import("../adapters/postgres.js");',
      'import { store } from "../stores/state.js";',
      'const storeAsync = import("../stores/state.js");',
      'import { repo } from "../repository/index.js";',
      'const repoAsync = import("../repository/index.js");',
      'import { service } from "../services/run.js";',
      'const serviceAsync = import("../services/run.js");',
      'import { database } from "../db/client.js";',
      'const databaseAsync = import("../db/client.js");',
      'import { value } from "../domain/value.js";',
      'import type { Input } from "../domain/types.js";',
      'const cleanAsync = import("../domain/value.js");',
      '// import { db } from "@myrmidon/db";',
      'const value = 1; // import { db } from "@myrmidon/db";',
      'import { sql2 } from "drizzle-orm"; // trailing comment',
      '',
    ].join("\n"));
    write(root, `${domain}/nested/view.tsx`, 'export const view = 1;\nimport fs from "node:fs/promises";\n');
    write(root, `${domain}/ignored.test.ts`, 'import fs from "node:fs";\n');
    write(root, `${domain}/ignored.test.tsx`, 'import fs from "node:fs";\n');
    write(root, `${domain}/ignored.myrmidon.test.ts`, 'import fs from "node:fs";\n');
    write(root, `${domain}/ignored.myrmidon.test.tsx`, 'import fs from "node:fs";\n');
    write(root, "server/src/modules/run-dispatch/domain-neighbor/outside.ts", 'import fs from "node:fs";\n');

    assert.deepEqual(checkDecisionLayerPurity(root).sort(), [
      "server/src/modules/run-dispatch/domain/matrix.ts:10: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:11: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:12: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:13: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:14: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:16: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:17: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:19: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:1: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:21: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:23: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:25: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:2: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:32: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:3: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:4: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:5: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:6: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:7: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:8: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/matrix.ts:9: decision layer imports I/O dependency (INV-14)",
      "server/src/modules/run-dispatch/domain/nested/view.tsx:2: decision layer imports I/O dependency (INV-14)",
    ]);

    write(root, `${domain}/matrix.ts`, 'import type { Input } from "../domain/types.js";\n');
    write(root, `${domain}/nested/view.tsx`, 'export const view = 1;\n');
    assert.deepEqual(checkDecisionLayerPurity(root), []);
  });
});
