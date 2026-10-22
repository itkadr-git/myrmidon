import {
  wsDiskApiResponseSchema,
  type WsDiskApiResponse,
} from "@paperclipai/shared";
import {
  BOT_DOCKER_SOCKET_ENV_NAME,
  dockergateDiskClientFromEnv,
  type DockergateDiskClient as DockergateSocketClient,
} from "../bot-containers/dockergate-disk-client.js";

/**
 * Client of the dockergate bot-partition API (myrmidon 1.6.5 BOT-DISK-H10,
 * contract C5).
 *
 * The board process runs in a container whose mount namespace is the host's
 * only for its own data volume; the bot partition (`/srv/myrmidon-xfs` on the
 * production host) is not bind-mounted in. `statfs` of the server data root
 * therefore says nothing about the partition the bots fill — on 07.10.2026
 * the partition reached 100 % while `/data` stayed fine. dockergate runs on
 * the host and reports the partition's physics; this client fetches
 * `GET /myrmidon/disk` (route id A14) and validates the answer against the
 * contract schema.
 *
 * H4a owns the dockergate side of the route; H10 only consumes it. When the
 * endpoint is unreachable, times out, or answers something the schema
 * rejects, the client returns null — the caller falls back to the previous
 * behaviour and the card says "not measured" rather than inventing numbers.
 */

export interface BotPartitionUsage {
  /** Mount point of the bot partition as dockergate reports it. */
  mount: string;
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
  /** Fractional percent straight from dockergate; callers round for display. */
  usedPercent: number;
  at: string;
}

export interface DockergateDiskClientOptions {
  /** Base URL of dockergate, e.g. `http://host.docker.internal:3399`. */
  baseUrl: string;
  /** Fetch timeout; the sweep must never hang on a dead dockergate. */
  timeoutMs?: number;
  /** Injected for tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface DockergateDiskClient {
  /** Partition usage, or null when dockergate cannot be read. */
  readPartitionUsage(): Promise<BotPartitionUsage | null>;
}

export const DOCKERGATE_DISK_DEFAULT_TIMEOUT_MS = 5_000;
export const DOCKERGATE_DISK_PATH = "/myrmidon/disk";

export function createDockergateDiskClient(
  options: DockergateDiskClientOptions,
): DockergateDiskClient {
  const timeoutMs = options.timeoutMs ?? DOCKERGATE_DISK_DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    async readPartitionUsage(): Promise<BotPartitionUsage | null> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${DOCKERGATE_DISK_PATH}`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json" },
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      const parsed = wsDiskApiResponseSchema.safeParse(body);
      if (!parsed.success) return null;
      const data: WsDiskApiResponse = parsed.data;
      return {
        mount: data.partition.mount,
        usedBytes: data.partition.usedBytes,
        totalBytes: data.partition.totalBytes,
        freeBytes: data.partition.freeBytes,
        usedPercent: data.partition.usedPercent,
        at: data.at,
      };
    },
  };
}

/** Env contract of the wiring (documented in the H10 change fragment). */
export const DOCKERGATE_URL_ENV = "MYRMIDON_DOCKERGATE_URL";

/**
 * The dockergate base URL the sweep wires by default. Null disables the
 * partition measurement entirely: the board keeps the statfs-based fallback
 * and the card says "not measured" — the contract for a host without
 * dockergate.
 */
export function dockergateBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[DOCKERGATE_URL_ENV]?.trim();
  return raw ? raw : null;
}

/**
 * Maps the C5 answer of the socket client onto the sweep's usage shape.
 * `partition.usedPercent` is already a 0..100 percent (dockergate rounds it to
 * one decimal), so it is passed through unchanged. Any failure (gate down,
 * deny, contract drift) is "not measured" (null), never a throw into the sweep.
 */
export function partitionClientFromSocketClient(
  gate: Pick<DockergateSocketClient, "getDisk">,
): DockergateDiskClient {
  return {
    async readPartitionUsage(): Promise<BotPartitionUsage | null> {
      try {
        const data = await gate.getDisk();
        return {
          mount: data.partition.mount,
          usedBytes: data.partition.usedBytes,
          totalBytes: data.partition.totalBytes,
          freeBytes: data.partition.freeBytes,
          usedPercent: data.partition.usedPercent,
          at: data.at,
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The partition client of this process. dockergate listens on a unix socket
 * on the production host (MYRMIDON_BOT_DOCKER_SOCKET, the same one the docker
 * driver and /bot-disk/physical use), so a configured socket wins; the TCP
 * client is built only when MYRMIDON_DOCKERGATE_URL is set. Neither: null
 * (the previous "not measured" behaviour).
 */
export function partitionClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): DockergateDiskClient | null {
  if (env[BOT_DOCKER_SOCKET_ENV_NAME]?.trim()) {
    return partitionClientFromSocketClient(dockergateDiskClientFromEnv(env));
  }
  const baseUrl = dockergateBaseUrl(env);
  return baseUrl ? createDockergateDiskClient({ baseUrl }) : null;
}
