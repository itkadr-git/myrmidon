import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@myrmidon/db";
import {
  putUpdateSettingsSchema,
  patchUpdateSettingsSchema,
  updateSettingsSchema,
  type UpdateSettings,
} from "@myrmidon/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";

export const UPDATE_SETTINGS_GENERAL_KEY = "myrmidonAutoUpdateSettings";
const SINGLETON_KEY = "default";

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  mode: "manual",
  window: {
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    fromMinute: 0,
    toMinute: 1439,
    timezone: "UTC",
  },
  canary: {
    enabled: false,
    sharePercent: 0,
    minBots: 1,
    maxBots: 5,
    healthSettleSec: 300,
  },
  autoRollback: {
    enabled: true,
    failureThresholdPercent: 10,
    healthTimeoutMinutes: 15,
  },
};

export function preserveUpdateSettingsGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[
    UPDATE_SETTINGS_GENERAL_KEY
  ];
  return value === undefined ? {} : { [UPDATE_SETTINGS_GENERAL_KEY]: value };
}

export interface UpdateSettingsService {
  get(): Promise<UpdateSettings>;
  replace(settings: UpdateSettings): Promise<UpdateSettings>;
  update(patch: Partial<UpdateSettings>): Promise<UpdateSettings>;
}

class InMemoryUpdateSettingsService implements UpdateSettingsService {
  private settings: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS };

  async get(): Promise<UpdateSettings> {
    return JSON.parse(JSON.stringify(this.settings));
  }

  async replace(settings: UpdateSettings): Promise<UpdateSettings> {
    this.settings = JSON.parse(JSON.stringify(settings));
    return this.get();
  }

  async update(patch: Partial<UpdateSettings>): Promise<UpdateSettings> {
    const current = await this.get();
    const merged: UpdateSettings = {
      ...current,
      ...patch,
      window: patch.window
        ? { ...(current.window ?? DEFAULT_UPDATE_SETTINGS.window!), ...patch.window }
        : current.window,
      canary: patch.canary
        ? { ...(current.canary ?? DEFAULT_UPDATE_SETTINGS.canary!), ...patch.canary }
        : current.canary,
      autoRollback: patch.autoRollback
        ? {
            ...(current.autoRollback ?? DEFAULT_UPDATE_SETTINGS.autoRollback!),
            ...patch.autoRollback,
          }
        : current.autoRollback,
    };
    this.settings = merged;
    return this.get();
  }
}

class DbUpdateSettingsService implements UpdateSettingsService {
  constructor(private db: Db) {}

  async get(): Promise<UpdateSettings> {
    try {
      const row = await this.db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
        .then((rows) => rows[0] ?? null);

      const raw = row?.general?.[UPDATE_SETTINGS_GENERAL_KEY];
      if (!raw) return { ...DEFAULT_UPDATE_SETTINGS };
      return updateSettingsSchema.parse(raw);
    } catch {
      return { ...DEFAULT_UPDATE_SETTINGS };
    }
  }

  async replace(settings: UpdateSettings): Promise<UpdateSettings> {
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(instanceSettings)
          .values({
            singletonKey: SINGLETON_KEY,
            general: {},
            experimental: {},
          })
          .onConflictDoNothing({ target: [instanceSettings.singletonKey] });

        const row = await tx
          .select({ id: instanceSettings.id })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
          .then((rows) => rows[0]);

        if (row) {
          await tx
            .update(instanceSettings)
            .set({
              general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${UPDATE_SETTINGS_GENERAL_KEY}}`}::text[], ${JSON.stringify(settings)}::jsonb, true)`,
            })
            .where(eq(instanceSettings.id, row.id));
        }
      });
      return settings;
    } catch {
      return settings;
    }
  }

  async update(patch: Partial<UpdateSettings>): Promise<UpdateSettings> {
    const current = await this.get();
    const merged: UpdateSettings = {
      ...current,
      ...patch,
      window: patch.window
        ? { ...(current.window ?? DEFAULT_UPDATE_SETTINGS.window!), ...patch.window }
        : current.window,
      canary: patch.canary
        ? { ...(current.canary ?? DEFAULT_UPDATE_SETTINGS.canary!), ...patch.canary }
        : current.canary,
      autoRollback: patch.autoRollback
        ? {
            ...(current.autoRollback ?? DEFAULT_UPDATE_SETTINGS.autoRollback!),
            ...patch.autoRollback,
          }
        : current.autoRollback,
    };
    return this.replace(merged);
  }
}

function assertCanManageUpdates(req: Request) {
  const actor = (req as any).actor;
  if (!actor) return;
  if (actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function updatesRoutes(
  db?: Db,
  customService?: UpdateSettingsService,
): Router {
  const router = Router();
  const service =
    customService ??
    (db && typeof db.select === "function"
      ? new DbUpdateSettingsService(db)
      : new InMemoryUpdateSettingsService());

  const getHandler = async (_req: Request, res: Response) => {
    assertCanManageUpdates(_req);
    const settings = await service.get();
    res.json(settings);
  };

  const putHandler = async (req: Request, res: Response) => {
    assertCanManageUpdates(req);
    const validated = putUpdateSettingsSchema.parse(req.body);
    const saved = await service.replace(validated);
    res.json(saved);
  };

  const patchHandler = async (req: Request, res: Response) => {
    assertCanManageUpdates(req);
    const validated = patchUpdateSettingsSchema.parse(req.body);
    const saved = await service.update(validated);
    res.json(saved);
  };

  const validateHandler = async (req: Request, res: Response) => {
    assertCanManageUpdates(req);
    const validated = updateSettingsSchema.parse(req.body);
    res.json({ valid: true, settings: validated });
  };

  // Standard paths
  router.get("/updates/settings", getHandler);
  router.put("/updates/settings", validate(putUpdateSettingsSchema), putHandler);
  router.patch(
    "/updates/settings",
    validate(patchUpdateSettingsSchema),
    patchHandler,
  );
  router.post(
    "/updates/validate",
    validate(updateSettingsSchema),
    validateHandler,
  );

  // Direct aliases on /updates
  router.get("/updates", getHandler);
  router.put("/updates", validate(putUpdateSettingsSchema), putHandler);
  router.patch("/updates", validate(patchUpdateSettingsSchema), patchHandler);

  // Myrmidon scoped aliases
  router.get("/myrmidon/updates/settings", getHandler);
  router.put(
    "/myrmidon/updates/settings",
    validate(putUpdateSettingsSchema),
    putHandler,
  );

  return router;
}
