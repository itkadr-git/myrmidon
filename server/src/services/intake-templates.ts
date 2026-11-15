// server/src/services/intake-templates.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Source templates defining title, priority, caste, and retry rules.
// Requirement: Source templates are data definitions, not imperative code.

export type IntakePriority = "low" | "medium" | "high" | "critical";

export interface IntakeSourceTemplate {
  /** Identifier of the source, e.g. "github", "zabbix", "alertmanager", "sentry", "generic" */
  source: string;
  /** Template string with placeholders like {{title}} or {{repository.name}} or {summary} */
  titleTemplate: string;
  /** Fallback title if interpolation is empty or fails */
  defaultTitle?: string;
  /** Optional template for issue description */
  descriptionTemplate?: string;
  /** Default priority for created task: "low" | "medium" | "high" | "critical" */
  priority?: IntakePriority;
  /** Path in payload to extract priority/severity from, e.g. "severity" or "priority" */
  priorityField?: string;
  /** Mapping of payload severity value to issue priority */
  priorityMap?: Record<string, IntakePriority>;
  /** Caste key to assign to the task, e.g. "engineering" */
  casteKey?: string | null;
  /** Path in payload to extract caste from */
  casteField?: string;
  /** Maximum retry attempts before marking the item as "failed" (default: 3) */
  maxRetries?: number;
  /** Required field paths in payload. If any are missing or empty, parsing fails (for validation) */
  requiredFields?: string[];
}

export interface ParsedIntakeDraft {
  title: string;
  description: string;
  priority: IntakePriority;
  casteKey: string | null;
  rawPayload: unknown;
}

/**
 * Resolves a property path from an object, supporting dot notation and array indices:
 * e.g. "repository.name", "alerts[0].annotations.summary", "event.title".
 */
export function resolvePayloadPath(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== "object" || !path) return undefined;

  // Normalize path segments, supporting bracket notation e.g. alerts[0].name -> alerts.0.name
  const normalized = path.replace(/\[(\w+)\]/g, ".$1").replace(/^\./, "");
  const parts = normalized.split(".");

  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Renders a template string by replacing {{field}} or {field} with values from payload.
 */
export function renderTemplateString(template: string, payload: unknown): string {
  if (!template) return "";
  return template.replace(/\{\{?([^{}]+)\}?\}/g, (_match, path) => {
    const val = resolvePayloadPath(payload, path.trim());
    if (val === undefined || val === null) return "";
    if (typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        return "";
      }
    }
    return String(val);
  });
}

/**
 * Default built-in source data templates.
 * These are pure data configurations.
 */
export const DEFAULT_INTAKE_TEMPLATES: Record<string, IntakeSourceTemplate> = {
  generic: {
    source: "generic",
    titleTemplate: "{{title}}",
    defaultTitle: "Webhook intake: {{event}}",
    priority: "medium",
    casteKey: "engineering",
    maxRetries: 3,
  },
  zabbix: {
    source: "zabbix",
    titleTemplate: "Zabbix: {{event_name}}",
    defaultTitle: "Zabbix: {{problem}}",
    priorityField: "severity",
    priorityMap: {
      disaster: "critical",
      high: "high",
      average: "medium",
      warning: "medium",
      information: "low",
      not_classified: "low",
    },
    casteKey: "engineering",
    maxRetries: 3,
  },
  alertmanager: {
    source: "alertmanager",
    titleTemplate: "Prometheus: {{alertname}}",
    defaultTitle: "Prometheus Alert: {{commonLabels.alertname}}",
    priorityField: "severity",
    priorityMap: {
      critical: "critical",
      error: "high",
      warning: "medium",
      info: "low",
    },
    casteKey: "engineering",
    maxRetries: 3,
  },
  github: {
    source: "github",
    titleTemplate: "GitHub [{{repository.name}}]: {{action}}",
    defaultTitle: "GitHub Event: {{action}}",
    priority: "medium",
    casteKey: "engineering",
    maxRetries: 3,
  },
  sentry: {
    source: "sentry",
    titleTemplate: "Sentry: {{message}}",
    defaultTitle: "Sentry Issue: {{event.title}}",
    priorityField: "level",
    priorityMap: {
      fatal: "critical",
      error: "high",
      warning: "medium",
      info: "low",
    },
    casteKey: "engineering",
    maxRetries: 3,
  },
};

export const INTAKE_TEMPLATES_ENV = "MYRMIDON_INTAKE_TEMPLATES";

/**
 * Resolves a template for a given source, checking custom templates, env config, and defaults.
 */
export function getIntakeTemplate(
  source: string,
  customTemplates?: Record<string, IntakeSourceTemplate> | IntakeSourceTemplate[],
  env: NodeJS.ProcessEnv = process.env,
): IntakeSourceTemplate {
  const normSource = source.toLowerCase().trim();

  // 1. Check custom templates if passed
  if (customTemplates) {
    if (Array.isArray(customTemplates)) {
      const found = customTemplates.find((t) => t.source.toLowerCase() === normSource);
      if (found) return found;
    } else if (customTemplates[normSource]) {
      return customTemplates[normSource];
    } else if (customTemplates[source]) {
      return customTemplates[source];
    }
  }

  // 2. Check environment variable JSON configuration
  const rawEnvTemplates = env[INTAKE_TEMPLATES_ENV]?.trim();
  if (rawEnvTemplates) {
    try {
      const parsed = JSON.parse(rawEnvTemplates);
      if (Array.isArray(parsed)) {
        const found = parsed.find((t) => t?.source?.toLowerCase() === normSource);
        if (found) return found;
      } else if (parsed[normSource]) {
        return parsed[normSource];
      }
    } catch {
      // Ignore JSON parse errors in env
    }
  }

  // 3. Check built-in default templates
  if (DEFAULT_INTAKE_TEMPLATES[normSource]) {
    return DEFAULT_INTAKE_TEMPLATES[normSource];
  }

  // 4. Wildcard template if provided in customTemplates
  if (customTemplates && !Array.isArray(customTemplates) && customTemplates["*"]) {
    return customTemplates["*"];
  }

  // 5. Fallback to generic template
  return {
    ...DEFAULT_INTAKE_TEMPLATES.generic,
    source,
  };
}

/**
 * Parses a webhook draft payload using the data template.
 * Throws an Error if the payload is unprocessable or fails required validations.
 */
export function parseWebhookDraft(
  template: IntakeSourceTemplate,
  payload: unknown,
  rawBody?: string,
): ParsedIntakeDraft {
  let effectivePayload = payload;

  if (effectivePayload == null || typeof effectivePayload !== "object") {
    if (rawBody && typeof rawBody === "string") {
      try {
        effectivePayload = JSON.parse(rawBody);
      } catch {
        throw new Error("Unprocessable webhook payload: payload is not valid JSON");
      }
    }
  }

  if (effectivePayload == null || typeof effectivePayload !== "object" || Array.isArray(effectivePayload)) {
    throw new Error("Unprocessable webhook payload: payload must be a non-empty object");
  }

  const payloadObj = effectivePayload as Record<string, unknown>;

  // Check explicit unparseable flag
  if (payloadObj.unparseable === true) {
    throw new Error("Unprocessable webhook payload: marked as unparseable");
  }

  // Check required fields if template specifies them
  if (template.requiredFields && template.requiredFields.length > 0) {
    for (const field of template.requiredFields) {
      const val = resolvePayloadPath(payloadObj, field);
      if (val === undefined || val === null || val === "") {
        throw new Error(`Unprocessable webhook payload: missing required field '${field}'`);
      }
    }
  }

  // Resolve title
  let title = renderTemplateString(template.titleTemplate, payloadObj).trim();
  if (!title && template.defaultTitle) {
    title = renderTemplateString(template.defaultTitle, payloadObj).trim();
  }
  if (!title && typeof payloadObj.title === "string" && payloadObj.title.trim()) {
    title = payloadObj.title.trim();
  }
  if (!title && typeof payloadObj.summary === "string" && payloadObj.summary.trim()) {
    title = payloadObj.summary.trim();
  }
  if (!title && typeof payloadObj.message === "string" && payloadObj.message.trim()) {
    title = payloadObj.message.trim();
  }

  // If title is still empty, parsing fails (cannot create a nameless task)
  if (!title) {
    throw new Error(`Unprocessable webhook payload: unable to generate title for source '${template.source}'`);
  }

  // Resolve priority
  let priority: IntakePriority = template.priority ?? "medium";
  if (template.priorityField) {
    const rawVal = resolvePayloadPath(payloadObj, template.priorityField);
    if (typeof rawVal === "string" && rawVal.trim()) {
      const key = rawVal.toLowerCase().trim();
      if (template.priorityMap && template.priorityMap[key]) {
        priority = template.priorityMap[key];
      } else if (["low", "medium", "high", "critical"].includes(key)) {
        priority = key as IntakePriority;
      }
    }
  }

  // Resolve casteKey
  let casteKey: string | null = template.casteKey ?? null;
  if (template.casteField) {
    const rawCaste = resolvePayloadPath(payloadObj, template.casteField);
    if (typeof rawCaste === "string" && rawCaste.trim()) {
      casteKey = rawCaste.trim();
    }
  }

  // Build description linking raw payload
  let customDescription = "";
  if (template.descriptionTemplate) {
    customDescription = renderTemplateString(template.descriptionTemplate, payloadObj).trim();
  }

  let formattedRaw = "";
  try {
    formattedRaw = JSON.stringify(effectivePayload, null, 2);
  } catch {
    formattedRaw = String(effectivePayload);
  }

  const descriptionParts: string[] = [];
  if (customDescription) {
    descriptionParts.push(customDescription);
  }
  descriptionParts.push(`### Webhook Intake (${template.source})\n\n#### Raw Payload\n\`\`\`json\n${formattedRaw}\n\`\`\``);

  const description = descriptionParts.join("\n\n");

  return {
    title,
    description,
    priority,
    casteKey,
    rawPayload: effectivePayload,
  };
}
