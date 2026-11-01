export const haStandbyStatusSchema = {
  $id: "ha-standby-status",
  type: "object",
  required: ["status", "checkedAt", "checks"],
  additionalProperties: false,
  properties: {
    status: { enum: ["ready", "unhealthy", "not_configured"] },
    checkedAt: { type: "string", format: "date-time" },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "status", "checkedAt"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: { enum: ["ready", "unhealthy", "not_configured"] },
          checkedAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;
