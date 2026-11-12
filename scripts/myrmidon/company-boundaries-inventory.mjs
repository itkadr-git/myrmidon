#!/usr/bin/env node
// myrmidon(1.7 COMPANY-BOUNDARIES): read-only inventory of agent-specific skills & instructions.
//
// Strictly read-only (HTTP GET only). Exports references & metadata only — never
// exports instruction file contents, prompt templates, or secret values.
//
// Usage:
//   PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... node scripts/myrmidon/company-boundaries-inventory.mjs
//   node scripts/myrmidon/company-boundaries-inventory.mjs --company-id <uuid> --api-url http://127.0.0.1:3100 --json
//   node scripts/myrmidon/company-boundaries-inventory.mjs --company-id <uuid> --fail-on-incomplete

import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "1.0.0";

export const PROBE_STATUS = Object.freeze({
  AVAILABLE: "available",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  UNAVAILABLE: "unavailable",
});

const KNOWN_DOMAINS = ["adm", "bbq", "work", "life"];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bpcp_[A-Za-z0-9_-]{4,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
  /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
];

function codeUnitCompare(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function redactSecrets(input) {
  if (input === null || input === undefined) return input;
  let text = String(input);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.source.startsWith("(https?:\\/\\/)")) {
      text = text.replace(pattern, "$1[REDACTED]:[REDACTED]@");
    } else if (pattern.source.startsWith("((?:password")) {
      text = text.replace(pattern, "$1[REDACTED]");
    } else if (pattern.source.startsWith("\\bBearer")) {
      text = text.replace(pattern, "Bearer [REDACTED]");
    } else if (pattern.source.startsWith("\\bBasic")) {
      text = text.replace(pattern, "Basic [REDACTED]");
    } else {
      text = text.replace(pattern, "[REDACTED]");
    }
  }
  return text;
}

export function containsPotentialSecret(input) {
  if (typeof input !== "string" || !input) return false;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) return true;
  }
  return false;
}

export function classifyHttpStatus(httpStatus) {
  if (httpStatus === 200) return PROBE_STATUS.AVAILABLE;
  if (httpStatus === 403) return PROBE_STATUS.FORBIDDEN;
  if (httpStatus === 404) return PROBE_STATUS.NOT_FOUND;
  return PROBE_STATUS.UNAVAILABLE;
}

export function sanitizeErrorReason(httpStatus, bodyText, err) {
  if (err) {
    return redactSecrets(err.message || String(err));
  }
  if (typeof bodyText === "string" && bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText);
      const msg = parsed?.error || parsed?.message || parsed?.details?.reason;
      if (typeof msg === "string" && msg.trim()) {
        return redactSecrets(msg.trim().slice(0, 240));
      }
    } catch {
      // fall through to truncated text
    }
    return redactSecrets(bodyText.trim().slice(0, 240));
  }
  return httpStatus ? `HTTP ${httpStatus}` : "Request failed";
}

export function inferAgentDomain(agent, fallbackDomain = null) {
  const explicit =
    typeof agent?.domain === "string" && agent.domain.trim()
      ? agent.domain.trim().toLowerCase()
      : typeof agent?.metadata?.domain === "string" && agent.metadata.domain.trim()
        ? agent.metadata.domain.trim().toLowerCase()
        : null;
  if (explicit) return redactSecrets(explicit);

  const candidates = [agent?.urlKey, agent?.name]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim().toLowerCase());
  for (const candidate of candidates) {
    for (const known of KNOWN_DOMAINS) {
      if (
        candidate === known ||
        candidate.startsWith(`${known}-`) ||
        candidate.startsWith(`${known}_`) ||
        candidate.startsWith(`${known}2-`)
      ) {
        return known;
      }
    }
  }

  if (typeof fallbackDomain === "string" && fallbackDomain.trim()) {
    return redactSecrets(fallbackDomain.trim().toLowerCase());
  }
  if (typeof agent?.companyId === "string" && agent.companyId.trim()) {
    return redactSecrets(agent.companyId.trim());
  }
  return "default";
}

export function normalizeSkillsSnapshot(raw) {
  const desiredSkills = Array.isArray(raw?.desiredSkills)
    ? [...new Set(raw.desiredSkills.map((s) => redactSecrets(String(s ?? ""))))].sort(codeUnitCompare)
    : [];

  const entries = Array.isArray(raw?.entries)
    ? raw.entries
        .map((entry) => ({
          key: redactSecrets(String(entry?.key ?? "")),
          runtimeName: entry?.runtimeName != null ? redactSecrets(String(entry.runtimeName)) : null,
          source: entry?.source != null ? redactSecrets(String(entry.source)) : null,
          required: Boolean(entry?.required),
          state: entry?.state != null ? redactSecrets(String(entry.state)) : null,
          origin: entry?.origin != null ? redactSecrets(String(entry.origin)) : null,
          originLabel: entry?.originLabel != null ? redactSecrets(String(entry.originLabel)) : null,
          readOnly: Boolean(entry?.readOnly),
          detail: entry?.detail != null ? redactSecrets(String(entry.detail)) : null,
        }))
        .sort((a, b) => codeUnitCompare(a.key, b.key) || codeUnitCompare(a.runtimeName, b.runtimeName))
    : [];

  const warnings = Array.isArray(raw?.warnings)
    ? [...new Set(raw.warnings.map((w) => redactSecrets(String(w ?? ""))))].sort(codeUnitCompare)
    : [];

  return {
    adapterType: raw?.adapterType != null ? redactSecrets(String(raw.adapterType)) : null,
    supported: Boolean(raw?.supported),
    mode: raw?.mode != null ? redactSecrets(String(raw.mode)) : null,
    desiredSkills,
    entries,
    warnings,
  };
}

export function normalizeInstructionsBundle(raw) {
  const files = Array.isArray(raw?.files)
    ? raw.files
        .map((file) => ({
          path: redactSecrets(String(file?.path ?? "")),
          size: typeof file?.size === "number" ? file.size : null,
          language: file?.language != null ? redactSecrets(String(file.language)) : null,
          markdown: Boolean(file?.markdown),
          isEntryFile: Boolean(file?.isEntryFile),
          editable: Boolean(file?.editable),
          deprecated: Boolean(file?.deprecated),
          virtual: Boolean(file?.virtual),
        }))
        .sort((a, b) => codeUnitCompare(a.path, b.path))
    : [];

  const warnings = Array.isArray(raw?.warnings)
    ? [...new Set(raw.warnings.map((w) => redactSecrets(String(w ?? ""))))].sort(codeUnitCompare)
    : [];

  return {
    mode: raw?.mode != null ? redactSecrets(String(raw.mode)) : null,
    entryFile: raw?.entryFile != null ? redactSecrets(String(raw.entryFile)) : null,
    rootPath: raw?.rootPath != null ? redactSecrets(String(raw.rootPath)) : null,
    editable: Boolean(raw?.editable),
    legacyPromptTemplateActive: Boolean(raw?.legacyPromptTemplateActive),
    legacyBootstrapPromptTemplateActive: Boolean(raw?.legacyBootstrapPromptTemplateActive),
    warnings,
    files,
  };
}

async function fetchJsonReadOnly(fetchImpl, url, headers) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
    });
  } catch (err) {
    return {
      status: PROBE_STATUS.UNAVAILABLE,
      httpStatus: null,
      reason: sanitizeErrorReason(null, null, err),
      data: null,
    };
  }

  const httpStatus = typeof response?.status === "number" ? response.status : null;
  let bodyText = "";
  try {
    bodyText = typeof response?.text === "function"
      ? await response.text()
      : JSON.stringify(await response.json());
  } catch (err) {
    return {
      status: classifyHttpStatus(httpStatus),
      httpStatus,
      reason: sanitizeErrorReason(httpStatus, null, err),
      data: null,
    };
  }

  if (httpStatus !== 200) {
    return {
      status: classifyHttpStatus(httpStatus),
      httpStatus,
      reason: sanitizeErrorReason(httpStatus, bodyText, null),
      data: null,
    };
  }

  try {
    const data = JSON.parse(bodyText);
    return {
      status: PROBE_STATUS.AVAILABLE,
      httpStatus: 200,
      reason: null,
      data,
    };
  } catch {
    return {
      status: PROBE_STATUS.UNAVAILABLE,
      httpStatus: 200,
      reason: "Invalid JSON response",
      data: null,
    };
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(concurrency || 4, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function emptyBucket() {
  return {
    available: 0,
    forbidden: 0,
    notFound: 0,
    unavailable: 0,
  };
}

function recordBucket(bucket, probeStatus) {
  if (probeStatus === PROBE_STATUS.AVAILABLE) bucket.available += 1;
  else if (probeStatus === PROBE_STATUS.FORBIDDEN) bucket.forbidden += 1;
  else if (probeStatus === PROBE_STATUS.NOT_FOUND) bucket.notFound += 1;
  else bucket.unavailable += 1;
}

function computeDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function probeCompanyBoundariesInventory(options = {}) {
  const companyId = typeof options.companyId === "string" ? options.companyId.trim() : "";
  if (!companyId) {
    throw new Error("companyId is required");
  }

  const apiUrl = String(options.apiUrl || "http://127.0.0.1:3100").replace(/\/+$/, "");
  const apiKey = options.apiKey ? String(options.apiKey).trim() : "";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  const concurrency = typeof options.concurrency === "number" && options.concurrency > 0 ? options.concurrency : 4;
  const fallbackDomain = options.domain ?? null;
  const filterAgentIds = Array.isArray(options.agentIds) && options.agentIds.length > 0
    ? new Set(options.agentIds.map((id) => String(id).trim()).filter(Boolean))
    : null;

  const headers = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const agentsProbe = await fetchJsonReadOnly(
    fetchImpl,
    `${apiUrl}/api/companies/${encodeURIComponent(companyId)}/agents`,
    headers,
  );

  const missingSources = [];
  const skillsBucket = emptyBucket();
  const instructionsBucket = emptyBucket();

  if (agentsProbe.status !== PROBE_STATUS.AVAILABLE) {
    missingSources.push({
      agentId: null,
      agentName: null,
      domain: fallbackDomain ? redactSecrets(String(fallbackDomain).toLowerCase()) : redactSecrets(companyId),
      source: "agents",
      status: agentsProbe.status,
      httpStatus: agentsProbe.httpStatus,
      reason: agentsProbe.reason,
    });

    const core = {
      schemaVersion: SCHEMA_VERSION,
      companyId: redactSecrets(companyId),
      coverage: {
        status: "unavailable",
        complete: false,
        agentsListStatus: agentsProbe.status,
        agentsListHttpStatus: agentsProbe.httpStatus,
        agentsTotal: 0,
        agentsProbed: 0,
        skills: skillsBucket,
        instructions: instructionsBucket,
        missingSources,
      },
      byDomain: {},
      agents: [],
    };

    return {
      ...core,
      ...(options.now ? { probedAt: new Date(options.now).toISOString() } : {}),
      probeDigest: computeDigest(core),
    };
  }

  const rawAgents = Array.isArray(agentsProbe.data)
    ? agentsProbe.data
    : Array.isArray(agentsProbe.data?.agents)
      ? agentsProbe.data.agents
      : [];

  const selectedAgents = rawAgents
    .filter((agent) => agent && typeof agent.id === "string" && agent.id.trim())
    .filter((agent) => !filterAgentIds || filterAgentIds.has(agent.id))
    .sort((a, b) => codeUnitCompare(a.id, b.id));

  const agentRecords = await mapWithConcurrency(selectedAgents, concurrency, async (agent) => {
    const agentId = String(agent.id);
    const agentName = redactSecrets(String(agent.name ?? agentId));
    const domain = inferAgentDomain(agent, fallbackDomain);

    const [skillsProbe, instructionsProbe] = await Promise.all([
      fetchJsonReadOnly(fetchImpl, `${apiUrl}/api/agents/${encodeURIComponent(agentId)}/skills`, headers),
      fetchJsonReadOnly(
        fetchImpl,
        `${apiUrl}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle`,
        headers,
      ),
    ]);

    recordBucket(skillsBucket, skillsProbe.status);
    recordBucket(instructionsBucket, instructionsProbe.status);

    if (skillsProbe.status !== PROBE_STATUS.AVAILABLE) {
      missingSources.push({
        agentId,
        agentName,
        domain,
        source: "skills",
        status: skillsProbe.status,
        httpStatus: skillsProbe.httpStatus,
        reason: skillsProbe.reason,
      });
    }

    if (instructionsProbe.status !== PROBE_STATUS.AVAILABLE) {
      missingSources.push({
        agentId,
        agentName,
        domain,
        source: "instructions",
        status: instructionsProbe.status,
        httpStatus: instructionsProbe.httpStatus,
        reason: instructionsProbe.reason,
      });
    }

    return {
      agentId,
      agentName,
      urlKey: agent.urlKey != null ? redactSecrets(String(agent.urlKey)) : null,
      companyId: agent.companyId != null ? redactSecrets(String(agent.companyId)) : redactSecrets(companyId),
      domain,
      role: agent.role != null ? redactSecrets(String(agent.role)) : null,
      status: agent.status != null ? redactSecrets(String(agent.status)) : null,
      adapterType: agent.adapterType != null ? redactSecrets(String(agent.adapterType)) : null,
      skills: {
        status: skillsProbe.status,
        httpStatus: skillsProbe.httpStatus,
        ...(skillsProbe.reason ? { reason: skillsProbe.reason } : {}),
        snapshot: skillsProbe.status === PROBE_STATUS.AVAILABLE
          ? normalizeSkillsSnapshot(skillsProbe.data)
          : null,
      },
      instructions: {
        status: instructionsProbe.status,
        httpStatus: instructionsProbe.httpStatus,
        ...(instructionsProbe.reason ? { reason: instructionsProbe.reason } : {}),
        bundle: instructionsProbe.status === PROBE_STATUS.AVAILABLE
          ? normalizeInstructionsBundle(instructionsProbe.data)
          : null,
      },
    };
  });

  agentRecords.sort((a, b) => codeUnitCompare(a.agentId, b.agentId));
  missingSources.sort(
    (a, b) =>
      codeUnitCompare(a.agentId ?? "", b.agentId ?? "") ||
      codeUnitCompare(a.source, b.source),
  );

  const byDomainAccumulator = new Map();
  for (const record of agentRecords) {
    if (!byDomainAccumulator.has(record.domain)) {
      byDomainAccumulator.set(record.domain, {
        agentsTotal: 0,
        skillsAvailable: 0,
        skillsIncomplete: 0,
        instructionsAvailable: 0,
        instructionsIncomplete: 0,
        skillEntriesCount: 0,
        desiredSkillsCount: 0,
        instructionFilesCount: 0,
      });
    }
    const summary = byDomainAccumulator.get(record.domain);
    summary.agentsTotal += 1;

    if (record.skills.status === PROBE_STATUS.AVAILABLE && record.skills.snapshot) {
      summary.skillsAvailable += 1;
      summary.skillEntriesCount += record.skills.snapshot.entries.length;
      summary.desiredSkillsCount += record.skills.snapshot.desiredSkills.length;
    } else {
      summary.skillsIncomplete += 1;
    }

    if (record.instructions.status === PROBE_STATUS.AVAILABLE && record.instructions.bundle) {
      summary.instructionsAvailable += 1;
      summary.instructionFilesCount += record.instructions.bundle.files.length;
    } else {
      summary.instructionsIncomplete += 1;
    }
  }

  const byDomain = {};
  for (const domainKey of [...byDomainAccumulator.keys()].sort(codeUnitCompare)) {
    byDomain[domainKey] = byDomainAccumulator.get(domainKey);
  }

  const complete = missingSources.length === 0;
  const coverageStatus = complete ? "complete" : "incomplete";

  const core = {
    schemaVersion: SCHEMA_VERSION,
    companyId: redactSecrets(companyId),
    coverage: {
      status: coverageStatus,
      complete,
      agentsListStatus: PROBE_STATUS.AVAILABLE,
      agentsListHttpStatus: 200,
      agentsTotal: agentRecords.length,
      agentsProbed: agentRecords.length,
      skills: skillsBucket,
      instructions: instructionsBucket,
      missingSources,
    },
    byDomain,
    agents: agentRecords,
  };

  return {
    ...core,
    ...(options.now ? { probedAt: new Date(options.now).toISOString() } : {}),
    probeDigest: computeDigest(core),
  };
}

export function formatInventorySummary(inventory) {
  const lines = [
    `Company Boundaries Inventory (schema ${inventory.schemaVersion})`,
    `Company: ${inventory.companyId}`,
    `Coverage: ${inventory.coverage.status} (complete=${inventory.coverage.complete})`,
    `Agents probed: ${inventory.coverage.agentsProbed}/${inventory.coverage.agentsTotal} (list=${inventory.coverage.agentsListStatus})`,
    `Skills: available=${inventory.coverage.skills.available}, forbidden=${inventory.coverage.skills.forbidden}, notFound=${inventory.coverage.skills.notFound}, unavailable=${inventory.coverage.skills.unavailable}`,
    `Instructions: available=${inventory.coverage.instructions.available}, forbidden=${inventory.coverage.instructions.forbidden}, notFound=${inventory.coverage.instructions.notFound}, unavailable=${inventory.coverage.instructions.unavailable}`,
    `Digest: ${inventory.probeDigest}`,
  ];

  const domains = Object.keys(inventory.byDomain || {});
  if (domains.length > 0) {
    lines.push("Domains:");
    for (const domain of domains) {
      const d = inventory.byDomain[domain];
      lines.push(
        `  - ${domain}: agents=${d.agentsTotal}, skills=${d.skillsAvailable}/${d.agentsTotal} (entries=${d.skillEntriesCount}), instructions=${d.instructionsAvailable}/${d.agentsTotal} (files=${d.instructionFilesCount})`,
      );
    }
  }

  if (inventory.coverage.missingSources.length > 0) {
    lines.push(`Incomplete/missing sources (${inventory.coverage.missingSources.length}):`);
    for (const gap of inventory.coverage.missingSources) {
      lines.push(
        `  - [${gap.status}${gap.httpStatus ? `/${gap.httpStatus}` : ""}] ${gap.agentName || gap.agentId || "company"} (${gap.source}): ${gap.reason || "unavailable"}`,
      );
    }
  }

  return lines.join("\n");
}

export function parseCliArgs(argv) {
  const opts = {
    companyId: process.env.PAPERCLIP_COMPANY_ID || "",
    apiUrl: process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100",
    apiKey: process.env.PAPERCLIP_API_KEY || "",
    domain: null,
    agentIds: [],
    json: false,
    failOnIncomplete: false,
    noTimestamp: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--fail-on-incomplete") {
      opts.failOnIncomplete = true;
    } else if (arg === "--no-timestamp") {
      opts.noTimestamp = true;
    } else if (arg === "--company-id" && i + 1 < argv.length) {
      opts.companyId = argv[++i];
    } else if (arg === "--api-url" && i + 1 < argv.length) {
      opts.apiUrl = argv[++i];
    } else if (arg === "--api-key" && i + 1 < argv.length) {
      opts.apiKey = argv[++i];
    } else if (arg === "--domain" && i + 1 < argv.length) {
      opts.domain = argv[++i];
    } else if (arg === "--agent-id" && i + 1 < argv.length) {
      const raw = argv[++i];
      for (const part of raw.split(",")) {
        if (part.trim()) opts.agentIds.push(part.trim());
      }
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(
      "Usage: company-boundaries-inventory.mjs --company-id <id> [--api-url <url>] [--domain <name>] [--agent-id <id>] [--json] [--fail-on-incomplete] [--no-timestamp]",
    );
    return 0;
  }

  if (!opts.companyId) {
    console.error("Error: --company-id or PAPERCLIP_COMPANY_ID is required");
    return 2;
  }

  const inventory = await probeCompanyBoundariesInventory({
    companyId: opts.companyId,
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    domain: opts.domain,
    agentIds: opts.agentIds,
    now: opts.noTimestamp ? undefined : new Date(),
  });

  if (opts.json) {
    console.log(JSON.stringify(inventory, null, 2));
  } else {
    console.log(formatInventorySummary(inventory));
  }

  if (opts.failOnIncomplete && !inventory.coverage.complete) {
    return 2;
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
