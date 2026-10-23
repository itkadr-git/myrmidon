// server/src/myrmidon/bot-containers/site-health-probe.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T4): one health probe of a remote site (remote-sites-v2 4.1).
//
// GET /v1/health over the same transport (address, bearer token, mTLS agent) the site's driver
// uses, with the 5 s timeout of the contract. The answer is reduced to what the health reducer
// takes as input:
//
//   answered and parsed             -> "success" (resourceDegraded when the site says it is degraded)
//   no answer in time, refused, 5xx -> "timeout" (the site is unavailable: counts toward the 90 s drain)
//   the TLS peer or the credentials
//   are rejected (bad/expired cert,
//   401/403)                        -> "invalid_certificate" (quarantine: everything stops for the owner)
//   answered with something that is
//   not the health contract         -> "incompatible_protocol" (quarantine)

import http from "node:http";
import https from "node:https";
import { SITE_HEALTH_TIMEOUT_MS, type SiteHealthResult } from "@myrmidon/shared/remote-sites/health-reducer";
import { parseRemoteSiteHealthResponse } from "./remote-site-contract.js";
import type { FleetSiteTransport } from "./site-registry.js";

export interface SiteProbeOutcome {
  result: SiteHealthResult;
  /** The site answered but reports itself degraded (docker down, egress failing). */
  resourceDegraded: boolean;
}

const TLS_REJECT_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_TLSV1_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_TLSV1_ALERT_CERTIFICATE_EXPIRED",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
]);

/** Pure mapping of a transport error to the reducer's result. */
export function classifyProbeError(err: unknown): SiteHealthResult {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TLS_REJECT_CODES.has(code)) return "invalid_certificate";
  return "timeout";
}

/** Pure mapping of an HTTP answer to the reducer's result. */
export function classifyProbeResponse(status: number, body: string): SiteProbeOutcome {
  if (status === 401 || status === 403) return { result: "invalid_certificate", resourceDegraded: false };
  if (status >= 500) return { result: "timeout", resourceDegraded: false };
  if (status !== 200) return { result: "incompatible_protocol", resourceDegraded: false };
  try {
    const health = parseRemoteSiteHealthResponse(JSON.parse(body));
    if (health.status === "unavailable") return { result: "timeout", resourceDegraded: false };
    return { result: "success", resourceDegraded: health.status !== "healthy" || health.egressCheck?.ok === false };
  } catch {
    return { result: "incompatible_protocol", resourceDegraded: false };
  }
}

export async function probeSiteHealth(transport: FleetSiteTransport, timeoutMs: number = SITE_HEALTH_TIMEOUT_MS): Promise<SiteProbeOutcome> {
  const url = new URL("/v1/health", transport.baseUrl);
  const client = url.protocol === "https:" ? https : http;
  return new Promise<SiteProbeOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: SiteProbeOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        path: url.pathname,
        method: "GET",
        headers: transport.token ? { Authorization: `Bearer ${transport.token}` } : {},
        agent: transport.agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // A health answer is a few hundred bytes; anything large is not the contract.
          if (size > 64 * 1024) {
            req.destroy();
            done({ result: "incompatible_protocol", resourceDegraded: false });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => done(classifyProbeResponse(res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8"))));
        res.on("error", (err) => done({ result: classifyProbeError(err), resourceDegraded: false }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ result: "timeout", resourceDegraded: false });
    });
    req.on("error", (err) => done({ result: classifyProbeError(err), resourceDegraded: false }));
    req.end();
  });
}
