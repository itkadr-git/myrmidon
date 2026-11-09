// Vendor-name gate (myrmidon 1.7 REBRAND-F) entry point.
//
// Router for app.ts: GET/PATCH /api/myrmidon/vendor-name-check. The setting is
// read from the instance settings at request time and the gate itself runs from
// the repository script — there is no startup apply step and no in-process
// cache, so nothing else needs wiring here.

import type { Db } from "@myrmidon/db";
import { vendorNameCheckRoutes } from "./routes.js";
import { vendorNameCheckService } from "./service.js";

export {
  vendorNameCheckService,
  VENDOR_NAME_CHECK_ACTION,
  type VendorNameCheckActor,
  type VendorNameCheckService,
  type VendorNameCheckView,
} from "./service.js";
export {
  readVendorNameCheck,
  normalizeStoredVendorNameCheck,
  preserveVendorNameCheckGeneralKey,
  VENDOR_NAME_CHECK_MODE_ENV,
  VENDOR_NAME_CHECK_BASELINE_ENV,
  VENDOR_NAME_CHECK_SETTINGS_KEY,
} from "./settings.js";
export {
  scanVendorName,
  resolveVendorNameCheckRoot,
  VENDOR_NAME_CHECK_SCRIPT,
  VENDOR_NAME_CHECK_POLICY,
  type VendorNameScanResult,
  type VendorNameScanTarget,
} from "./scan.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/vendor-name-check. */
export function myrmidonVendorNameCheckRoutes(db: Db) {
  return vendorNameCheckRoutes(db, vendorNameCheckService(db));
}