// Behavior settings module entry point (myrmidon 1.7, SETTINGS-TO-UI A)

export { 
  behaviorSettingsService, 
  type BehaviorSettingsService,
  type BehaviorSettingsActor,
  BEHAVIOR_SETTINGS_INSTANCE_ACTION,
  BEHAVIOR_SETTINGS_COMPANY_ACTION
} from "./service.js";

export { 
  behaviorSettingsRoutes 
} from "./routes.js";