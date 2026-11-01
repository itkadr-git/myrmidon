import fs from \"node:fs\";
import net from \"node:net\";
import { execFile } from \"node:child_process\";
import * as p from \"@clack/prompts\";
import pc from \"picocolors\";
import {
  buildGeoCheckReport,
  evaluateDockerReadiness,
  evaluateMirrorConfigReadiness,
  evaluateOsReadiness,
  evaluatePgClientReadiness,
  evaluatePortReadiness,
  evaluateSecretsReadiness,
  geoCheckOptionsSchema,
  parseOsRelease,
  type GeoCheckItem,
  type GeoCheckOptions,
  type GeoCheckReport,
} from \"@myrmidon/shared\";
import { loadPaperclipEnvFile } from \"../config/env.js\";
import { resolveConfigPath } from \"../config/store.js\";
import { printMyrmidonCliBanner } from \"../utils/banner.js\";

const STATUS_ICON = {
  pass: pc.green(\"✓\"),
  fail: pc.red(\"✗\"),
} as const;

export interface GeoCheckDependencies {
  readOsRelease?: () => string | null;
  execCmd?: (file: string, args: string[], timeoutMs?: number) => Promise<string | null>;
  probePort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  readMirrorConfig?: (path: string) => string | null;
  env?: Record<string, string | undefined>;
}

export function defaultExecCmd(
  file: string,
  args: string[],
  timeoutMs = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: \"utf-8\" }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout);
    });
  });
}

export function defaultProbePort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once(\"connect\", () => {
      cleanup();
      resolve(true);
    });
    socket.once(\"timeout\", () => {
      cleanup();
      resolve(false);
    });
    socket.once(\"error\", () => {
      cleanup();
      resolve(false);
    });

    try {
      socket.connect(port, host);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

export function defaultReadOsRelease(): string | null {
  try {
    if (fs.existsSync(\"/etc/os-release\")) {
      return fs.readFileSync(\"/etc/os-release\", \"utf-8\");
    }
  } catch {
    // ignore
  }
  return null;
}

export function defaultReadMirrorConfig(path: string): string | null {
  try {
    if (fs.existsSync(path)) {
      return fs.readFileSync(path, \"utf-8\");
    }
  } catch {
    // ignore
  }
  return null;
}

export async function executeGeoCheck(
  options: GeoCheckOptions,
  deps: GeoCheckDependencies = {},
): Promise<GeoCheckReport> {
  const readOs = deps.readOsRelease ?? defaultReadOsRelease;
  const exec = deps.execCmd ?? defaultExecCmd;
  const probe = deps.probePort ?? defaultProbePort;
  const readMirror = deps.readMirrorConfig ?? defaultReadMirrorConfig;
  const env = deps.env ?? process.env;

  const checks: GeoCheckItem[] = [];

  // 1. OS version check
  const osRaw = readOs();
  const osInfo = osRaw ? parseOsRelease(osRaw) : null;
  checks.push(evaluateOsReadiness(osInfo, options.minOsMajor));

  // 2. Docker version check
  const dockerRaw = await exec(\"docker\", [\"version\", \"--format\", \"{{.Server.Version}}\"], 5000);
  checks.push(evaluateDockerReadiness(dockerRaw, options.minDockerMajor));

  // 3. PostgreSQL client check
  const psqlRaw = await exec(\"psql\", [\"--version\"], 5000);
  checks.push(evaluatePgClientReadiness(psqlRaw, options.minPgMajor));

  // 4. PostgreSQL port reachability
  const pgReachable = await probe(options.pgHost, options.pgPort, options.timeoutMs);
  checks.push(evaluatePortReadiness(\"PostgreSQL\", options.pgHost, options.pgPort, pgReachable));

  // 5. LiteLLM port reachability
  const litellmReachable = await probe(options.litellmHost, options.litellmPort, options.timeoutMs);
  checks.push(evaluatePortReadiness(\"LiteLLM\", options.litellmHost, options.litellmPort, litellmReachable));

  // 6. Secret quorum
  const secretNames = options.secrets
    .split(\",\")
    .map((s) => s.trim())
    .filter(Boolean);
  checks.push(evaluateSecretsReadiness(secretNames, env));

  // 7. LiteLLM mirror config
  const mirrorConfigContent = options.mirrorConfig ? readMirror(options.mirrorConfig) : null;
  checks.push(evaluateMirrorConfigReadiness(options.mirrorConfig, mirrorConfigContent));

  return buildGeoCheckReport(checks);
}

export async function geoCheckCommand(
  rawOpts: Record<string, unknown>,
  deps: GeoCheckDependencies = {},
): Promise<GeoCheckReport> {
  const configPath = resolveConfigPath(typeof rawOpts.config === \"string\" ? rawOpts.config : undefined);
  loadPaperclipEnvFile(configPath);

  const env = deps.env ?? process.env;
  const rawInput = {
    ...rawOpts,
    pgHost: rawOpts.pgHost ?? env.POSTGRES_HOST,
    pgPort: rawOpts.pgPort ?? env.POSTGRES_PORT,
    litellmHost: rawOpts.litellmHost ?? env.LITELLM_HOST,
    litellmPort: rawOpts.litellmPort ?? env.LITELLM_PORT,
    secrets: rawOpts.secrets ?? env.REQUIRED_SECRETS,
    mirrorConfig: rawOpts.mirrorConfig ?? env.LITELLM_MIRROR_CONFIG,
    minOsMajor: rawOpts.minOsMajor ?? env.OS_MIN_MAJOR,
    minDockerMajor: rawOpts.minDockerMajor ?? env.DOCKER_MIN_MAJOR,
    minPgMajor: rawOpts.minPgMajor ?? env.POSTGRES_MIN_MAJOR,
    timeoutMs: rawOpts.timeout,
    json: rawOpts.json === true,
  };

  const parsed = geoCheckOptionsSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid geo-check options: ${parsed.error.errors.map((e) => `${e.path.join(\".\")}: ${e.message}`).join(\", \")}`;
    if (rawOpts.json) {
      console.error(JSON.stringify({ error: errorMsg, details: parsed.error.format() }));
    } else {
      p.log.error(pc.red(errorMsg));
    }
    process.exitCode = 1;
    throw new Error(errorMsg);
  }

  const options = parsed.data;

  if (!options.json) {
    printMyrmidonCliBanner();
    p.intro(pc.bgCyan(pc.black(\" myrmidon geo-check \")));
  }

  const report = await executeGeoCheck(options, { ...deps, env });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const check of report.checks) {
      const icon = STATUS_ICON[check.status];
      const tag = check.status === \"pass\" ? pc.green(\"[PASS]\") : pc.red(\"[FAIL]\");
      p.log.message(`${icon} ${tag} ${pc.bold(check.name)}: ${check.detail}`);
    }

    const summaryParts: string[] = [];
    summaryParts.push(pc.green(`${report.passedChecks} passed`));
    if (report.failedChecks > 0) {
      summaryParts.push(pc.red(`${report.failedChecks} failed`));
    }
    p.note(summaryParts.join(\", \"), \"Summary\");

    if (report.passed) {
      p.outro(pc.green(\"Standby readiness: PASS\"));
    } else {
      p.outro(pc.red(`Standby readiness: FAIL (${report.failedChecks} ${report.failedChecks === 1 ? \"check\" : \"checks\"})`));
    }
  }

  if (!report.passed) {
    process.exitCode = 1;
  }

  return report;
}
