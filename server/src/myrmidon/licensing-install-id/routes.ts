import { Router } from "express";
import { assertInstanceAdmin } from "../../routes/authz.js";
import type { InstallIdProvider } from "../licensing/install-id.js";

// The id comes from the board database (see licensing/install-id.ts); this
// route no longer reads the machine id or the environment itself.
export function licensingInstallIdRoutes(installId: InstallIdProvider) {
  const router = Router();
  router.get("/licensing/install-id", async (req, res, next) => {
    try {
      assertInstanceAdmin(req);
      const id = await installId();
      res.json({
        install_id: id.installId,
        source: id.source === "env" ? "MYR_LICENSE_INSTANCE_ID" : id.source,
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
