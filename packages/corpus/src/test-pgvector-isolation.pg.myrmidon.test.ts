import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function waitForOutput(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(marker)) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`process exited ${code}: ${output} ${errors}`)));
  });
}

let supported = process.platform === "linux" && process.arch === "x64";
try {
  const entry = require.resolve("embedded-postgres");
  await access(path.resolve(path.dirname(path.dirname(entry)), "..", "@embedded-postgres", `linux-${process.arch}`, "native"));
} catch {
  supported = false;
}

describe.skipIf(!supported)("pgvector installer isolation", () => {
  it("serializes independent installers on a clean shared native tree and retains the extension after cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pgvector-isolation-"));
    const native = path.join(root, "node_modules", "@embedded-postgres", `linux-${process.arch}`, "native");
    const fakePackage = path.join(root, "node_modules", "embedded-postgres");
    const children: ChildProcessWithoutNullStreams[] = [];
    try {
      await mkdir(native, { recursive: true });
      await mkdir(path.join(fakePackage, "dist"), { recursive: true });
      await writeFile(path.join(fakePackage, "package.json"), JSON.stringify({ main: "dist/index.js" }));
      await writeFile(path.join(fakePackage, "dist", "index.js"), "");
      await copyFile(fileURLToPath(new URL("./test-pgvector.ts", import.meta.url)), path.join(root, "test-pgvector.ts"));
      await writeFile(path.join(root, "worker.mjs"), `
        import { installPgvectorIntoEmbeddedCluster } from './test-pgvector.ts';
        const realFetch = globalThis.fetch;
        globalThis.fetch = (...args) => { process.stdout.write('FETCH\\n'); return realFetch(...args); };
        process.stdout.write('START\\n');
        const result = await installPgvectorIntoEmbeddedCluster();
        if (!result.ok) throw new Error(result.reason);
        process.stdout.write('INSTALLED\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        await result.cleanup();
        process.stdout.write('CLEANED\\n');
      `);
      const holder = spawn("flock", ["-x", path.join(native, ".pgvector-install.lock"), "sh", "-c", "printf 'LOCKED\\n'; cat >/dev/null"]);
      children.push(holder);
      await waitForOutput(holder, "LOCKED");
      const workers = [0, 1].map(() => spawn(process.execPath, [path.join(root, "worker.mjs")]));
      children.push(...workers);
      let fetchedWhileLocked = false;
      const starts = workers.map((worker) => {
        worker.stdout.on("data", (chunk) => { if (String(chunk).includes("FETCH")) fetchedWhileLocked = true; });
        return waitForOutput(worker, "START");
      });
      await Promise.all(starts);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(fetchedWhileLocked).toBe(false);
      const installed = workers.map((worker) => waitForOutput(worker, "INSTALLED"));
      holder.stdin.end();
      await Promise.all(installed);
      const cleaned = waitForOutput(workers[0]!, "CLEANED");
      workers[0]!.stdin.write("cleanup\n");
      await cleaned;
      await expect(access(path.join(native, "share", "postgresql", "extension", "vector.control"))).resolves.toBeUndefined();
      await expect(access(path.join(native, "lib", "postgresql", "vector.so"))).resolves.toBeUndefined();
      const secondCleaned = waitForOutput(workers[1]!, "CLEANED");
      workers[1]!.stdin.write("cleanup\n");
      await secondCleaned;
    } finally {
      for (const child of children) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
