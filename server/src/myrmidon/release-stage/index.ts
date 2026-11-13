import { Router } from "express";

// myrmidon(1.8 RELEASE-STAGE): the module barrel — service, routes.
export {
  createReleaseStageService,
  createInMemoryReleaseStageStore,
  releaseStageView,
  releaseGatesComplete,
  resolveReleaseAuthority,
  evaluatePublication,
  RELEASE_ACTION_FORBIDDEN_CODE,
  RELEASE_GATES_INCOMPLETE_CODE,
  RELEASE_SIGNATURE_REQUIRED_CODE,
  RELEASE_STAGE_NOT_FOUND_CODE,
  type ReleaseStageService,
  type ReleaseStageStore,
  type ReleaseStageView,
  type ReleaseActor,
  type ReleaseAuthorityDecision,
} from "./service.js";
export { releaseStageRoutes, myrmidonReleaseStageRoutes, type ReleaseStageRoutesDeps } from "./routes.js";

// Placeholder export to keep the barrel honest until the UI wires the screen.
export const RELEASE_STAGE_MODULE_VERSION = 1;
export type ReleaseStageRouter = Router;
