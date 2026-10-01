/**
 * Windows Credential Store binding. Uses the CredRead/CredWrite Win32 API via
 * PowerShell only as a thin, inspectable bridge for development; the shipped
 * integration compiles the host with a native addon or uses the middleware's
 * own storage. No PIN is ever written to a file by this code path.
 *
 * The default credential blob type is Generic (CRED_TYPE_GENERIC = 1).
 */
import type { CredentialStore } from "./pin.ts";

export interface PowerShellRunner {
  exec(script: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Builds a CredentialStore backed by the Win32 CredRead/CredWrite API through PowerShell. */
export function windowsCredentialStore(runner: PowerShellRunner): CredentialStore {
  const quote = (value: string) => `'` + value.replace(/'/g, `''`) + `'`;
  return {
    async readPin(target: string): Promise<Buffer | null> {
      const script = [
        `$ErrorActionPreference = 'Stop'`,
        `$c = [Windows.Win32.CredRead]::Read(${quote(target)})`,
        `if ($null -eq $c) { exit 3 }`,
        `$b = [Convert]::ToBase64String($c.CredentialBlob)`,
        `Write-Output $b`,
      ].join("\n");
      const { code, stdout } = await runner.exec(script);
      if (code !== 0) return null;
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      return Buffer.from(trimmed, "base64");
    },
    async writePin(target: string, pin: Buffer): Promise<void> {
      const script = [
        `$ErrorActionPreference = 'Stop'`,
        `$blob = [Convert]::FromBase64String(${quote(pin.toString("base64"))})`,
        `[Windows.Win32.CredWrite]::Write(${quote(target)}, $blob)`,
      ].join("\n");
      const { code } = await runner.exec(script);
      if (code !== 0) throw new Error("CredWrite failed");
    },
    async deletePin(target: string): Promise<void> {
      const script = [
        `$ErrorActionPreference = 'Stop'`,
        `[Windows.Win32.CredDelete]::Delete(${quote(target)})`,
      ].join("\n");
      await runner.exec(script);
    },
  };
}
