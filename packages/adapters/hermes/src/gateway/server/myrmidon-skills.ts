// myrmidon(OPE-9033): skill listing/sync for hermes_gateway. Delivery itself
// already exists (run-body field paperclip_skills, see
// myrmidon-skills-reconcile.ts); what was missing was the adapter's
// listSkills/syncSkills pair, so GET /agents/:id/skills answered
// supported:false and the board refused to record desired skills for the agent.
// The gateway profile is remote and unreadable from here, so the snapshot
// describes what the NEXT run delivers (ephemeral), not what is installed.

import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@myrmidon/adapter-utils";
import { PRODUCT_NAME } from "@myrmidon/adapter-utils";
import {
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@myrmidon/adapter-utils/server-utils";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildGatewaySkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const available = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, available);
  const desiredSet = new Set(desiredSkills);
  const availableKeys = new Set(available.map((e) => e.key));
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  for (const entry of available) {
    const desired = desiredSet.has(entry.key);
    const sourceMissing = desired && isPaperclipSkillSourceMissing(entry);
    if (sourceMissing) warnings.push(`Skill "${entry.key}" source is missing; the run will refuse to start.`);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: sourceMissing ? "missing" : desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: `Managed by ${PRODUCT_NAME}`,
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Delivered into the Hermes gateway profile with each run (paperclip_skills)."
        : null,
    });
  }
  for (const key of desiredSkills) {
    if (availableKeys.has(key)) continue;
    warnings.push(`Desired skill "${key}" is not available in ${PRODUCT_NAME}.`);
    entries.push({
      key,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: `Cannot find this skill in ${PRODUCT_NAME}.`,
    });
  }
  return { adapterType: "hermes_gateway", supported: true, mode: "ephemeral", desiredSkills, entries, warnings };
}

export async function listGatewaySkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildGatewaySkillSnapshot(ctx.config);
}

export async function syncGatewaySkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildGatewaySkillSnapshot(ctx.config);
}
