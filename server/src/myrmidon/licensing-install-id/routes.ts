import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Router } from "express";
import { assertInstanceAdmin } from "../../routes/authz.js";

const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;

function readMachineId(): string {
  for (const path of MACHINE_ID_PATHS) {
    try {
      const id = readFileSync(path, "utf8").trim();
      if (id) return id;
    } catch {
      // Try the fallback path when the primary machine-id file is unavailable.
    }
  }
  throw new Error("Machine ID is unavailable");
}

export function licensingInstallIdRoutes(readInstallMachineId = readMachineId) {
  const router = Router();
  router.get("/licensing/install-id", (req, res, next) => {
    try {
      assertInstanceAdmin(req);
      const override = process.env.MYR_LICENSE_INSTANCE_ID?.trim();
      if (override) {
        res.json({ install_id: override, source: "MYR_LICENSE_INSTANCE_ID" });
        return;
      }
      const machineId = readInstallMachineId();
      const installId = `myr-${createHash("sha256").update(machineId, "utf8").digest("hex").slice(0, 20)}`;
      res.json({ install_id: installId, source: "machine-id" });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
