// myrmidon(OPE-13218): test fixture. A `git daemon` on 127.0.0.1 serves the temp directory, and
// a git config rewrite (GIT_CONFIG_COUNT) maps `<tmpdir>/` to it, so a bare repository on disk
// looks like a real network remote (git://) to host-clone-cache-gc.mjs.
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

export async function startGitDaemon() {
  const base = os.tmpdir();
  const port = await freePort();
  const child = spawn("git", ["daemon", `--base-path=${base}`, "--export-all", "--enable=receive-pack", "--listen=127.0.0.1", `--port=${port}`], { stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 100 && !(await canConnect(port)); i++) await new Promise((r) => setTimeout(r, 50));
  return {
    port,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.git://127.0.0.1:${port}/.insteadOf`,
      GIT_CONFIG_VALUE_0: `${base.replace(/\/+$/, "")}/`,
    },
    stop: () => { child.kill(); },
  };
}
