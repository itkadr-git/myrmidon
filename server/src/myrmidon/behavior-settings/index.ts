// Behavior settings module entry point (myrmidon 1.7, SETTINGS-TO-UI A)

export {
  behaviorSettingsService,
  type BehaviorSettingsService,
  type BehaviorSettingsActor,
  type BehaviorSettingsServiceDeps,
  BEHAVIOR_SETTINGS_INSTANCE_ACTION,
  BEHAVIOR_SETTINGS_COMPANY_ACTION,
} from "./service.js";

export { behaviorSettingsRoutes } from "./routes.js";

export {
  BEHAVIOR_SETTINGS_GENERAL_KEY,
  BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY,
  preserveBehaviorSettingsGeneralKeys,
} from "./store.js";
