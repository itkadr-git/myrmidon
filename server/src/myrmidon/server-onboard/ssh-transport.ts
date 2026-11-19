import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { SshConnectionOptions, SshExecuteOptions, SshExecutionResult, SshExecutor } from "../../services/fleet/mock-ssh-executor.js";

/** SSH2 pauses the handshake until the asynchronous pin decision completes. */
export class OnboardSshTransport implements SshExecutor {
  private client: Client | null = null;
  private connected = false;

  async connect(options?: SshConnectionOptions): Promise<void> {
    if (!options?.hostVerifier) throw new Error("SSH host verifier is required");
    if (this.client) throw new Error("SSH transport already used");
    const client = new Client();
    this.client = client;
    const verify = options.hostVerifier;
    await new Promise<void>((resolve, reject) => {
      client.once("ready", () => { this.connected = true; resolve(); });
      client.once("error", reject);
      client.once("close", () => { this.connected = false; });
      client.connect({
        host: options.host, port: options.port ?? 22, username: options.username,
        password: options.password, privateKey: options.privateKey, passphrase: options.passphrase,
        readyTimeout: options.timeoutMs ?? 20000,
        hostVerifier: (key, callback) => {
          const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          void Promise.resolve().then(() => verify(fingerprint)).then(
            (accepted) => callback(accepted), () => callback(false),
          );
        },
      });
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client?.end();
    this.client = null;
  }

  isConnected(): boolean { return this.connected; }

  async exec(command: string, options?: SshExecuteOptions): Promise<SshExecutionResult> {
    return this.execute(command, options);
  }

  async execute(command: string, options?: SshExecuteOptions): Promise<SshExecutionResult> {
    if (!this.client || !this.connected) throw new Error("SSH transport is not connected");
    if (options?.cwd || options?.sudo || options?.timeoutMs) throw new Error("Unsupported SSH command option");
    const started = Date.now();
    return new Promise((resolve, reject) => {
      this.client!.exec(command, { env: options?.env }, (error, stream) => {
        if (error) { reject(error); return; }
        let stdout = ""; let stderr = "";
        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        stream.once("error", reject);
        stream.once("close", (code: number | undefined, signal: string | undefined) => {
          resolve({ stdout, stderr, exitCode: code ?? -1, signal: signal ?? null, durationMs: Date.now() - started });
        });
        if (options?.stdin !== undefined) stream.end(options.stdin);
      });
    });
  }
}
