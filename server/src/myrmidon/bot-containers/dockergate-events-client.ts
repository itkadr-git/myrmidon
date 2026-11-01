// myrmidon(OPE-9934): dockergate OOM events client.
import http from "node:http";
import type { DriverOomEvent } from "./container-oom.js";
import {
  BOT_DOCKER_SOCKET_ENV_NAME,
  DEFAULT_DOCKERGATE_SOCKET,
  type DockergateHttpResponse,
  type DockergateTransport,
} from "./dockergate-disk-client.js";

const REQUEST_TIMEOUT_MS = 5_000;

export interface DockergateEventsClient {
  getOomEvents(sinceNano?: number): Promise<DriverOomEvent[]>;
}

export function createDockergateEventsClient(options: {
  socketPath?: string;
  transport?: DockergateTransport;
}): DockergateEventsClient {
  const socketPath = options.socketPath || DEFAULT_DOCKERGATE_SOCKET;
  const transport = options.transport || defaultTransport(socketPath);

  return {
    async getOomEvents(sinceNano?: number): Promise<DriverOomEvent[]> {
      const query = typeof sinceNano === "number" && sinceNano > 0 ? `?since=${sinceNano}` : "";
      const res = await transport({
        method: "GET",
        path: `/myrmidon/events/oom${query}`,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`dockergate GET /myrmidon/events/oom failed: ${res.status} ${res.body.slice(0, 200)}`);
      }
      try {
        const parsed = JSON.parse(res.body) as { events?: DriverOomEvent[] };
        return parsed.events ?? [];
      } catch {
        throw new Error("dockergate GET /myrmidon/events/oom: answer is not JSON");
      }
    },
  };
}

function defaultTransport(socketPath: string): DockergateTransport {
  return (req) =>
    new Promise<DockergateHttpResponse>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: req.path,
          method: req.method,
          headers: {
            host: "dockergate",
            accept: "application/json",
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(new Error(`dockergate ${req.method} ${req.path} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });
      request.end();
    });
}

export function dockergateEventsClientFromEnv(env: NodeJS.ProcessEnv = process.env): DockergateEventsClient {
  return createDockergateEventsClient({
    socketPath: env[BOT_DOCKER_SOCKET_ENV_NAME]?.trim() || DEFAULT_DOCKERGATE_SOCKET,
  });
}
