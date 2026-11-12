// server/src/myrmidon/bot-containers/resource-ceilings.ts
//
// Live per-bot ceilings from dockergate's enrolled config (A21, OPE-12337).
// Never infer a ceiling from card defaults: dockergate is the authority.

import http from "node:http";
import { BOT_DOCKER_SOCKET_ENV_NAME, DEFAULT_DOCKERGATE_SOCKET } from "./dockergate-disk-client.js";

export interface BotResourceCeilings {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

type CeilingsReader = (botKey: string, env?: NodeJS.ProcessEnv) => Promise<BotResourceCeilings | null>;

let testCeilingsReader: CeilingsReader | null = null;

export function setBotResourceCeilingsReaderForTest(reader: CeilingsReader | null): void {
  testCeilingsReader = reader;
}

export async function readBotResourceCeilings(
  botKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BotResourceCeilings | null> {
  if (testCeilingsReader) {
    return testCeilingsReader(botKey, env);
  }

  const socketPath = env[BOT_DOCKER_SOCKET_ENV_NAME]?.trim() || DEFAULT_DOCKERGATE_SOCKET;
  return new Promise((resolve) => {
    const req = http.get(
      {
        socketPath,
        path: `/myrmidon/bots/${encodeURIComponent(botKey)}/limits`,
        timeout: 3_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return resolve(null);
          }
          try {
            const value: unknown = JSON.parse(body);
            if (!value || typeof value !== "object") return resolve(null);
            const limits = value as Record<string, unknown>;
            const memoryMb = typeof limits.effectiveMemoryMb === "number" ? limits.effectiveMemoryMb : limits.memoryMb;
            const cpus = typeof limits.effectiveCpus === "number" ? limits.effectiveCpus : limits.cpus;
            const pidsLimit = typeof limits.effectivePidsLimit === "number" ? limits.effectivePidsLimit : limits.pidsLimit;

            if (
              typeof memoryMb === "number" &&
              Number.isFinite(memoryMb) &&
              memoryMb > 0 &&
              typeof cpus === "number" &&
              Number.isFinite(cpus) &&
              cpus > 0 &&
              typeof pidsLimit === "number" &&
              Number.isInteger(pidsLimit) &&
              pidsLimit > 0
            ) {
              resolve({ memoryMb, cpus, pidsLimit });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => {
      resolve(null);
    });
  });
}

export function botResourceCeilingProblem(
  container: Record<string, unknown>,
  ceilings: BotResourceCeilings,
): string | null {
  for (const [field, configName, unit] of [
    ["memoryMb", "maxMemoryMb", " МБ"],
    ["cpus", "maxCpus", " CPU"],
    ["pidsLimit", "maxPids", " PIDs"],
  ] as const) {
    const requested = container[field];
    const limit = ceilings[field as keyof BotResourceCeilings];
    if (typeof requested === "number" && requested > limit) {
      return `adapterConfig.container.${field} ${requested} exceeds dockergate ceiling ${limit}${unit} for this bot; raise bots[].${configName} in dockergate config.json and reload dockergate (SIGHUP)`;
    }
  }
  return null;
}
