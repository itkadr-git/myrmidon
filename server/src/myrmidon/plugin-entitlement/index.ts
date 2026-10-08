// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): instance-level plugin entitlement keys.
export { pluginEntitlementRoutes } from "./routes.js";
export {
  readPluginEntitlementKeys,
  readPluginEntitlementPublicKey,
  readPluginEntitlementPublicKeyWithSource,
  writePluginEntitlementPublicKey,
  acceptPluginEntitlementKey,
  removePluginEntitlementKey,
  preservePluginEntitlementKeysGeneralKey,
  preservePluginEntitlementPublicKeyGeneralKey,
  PLUGIN_ENTITLEMENT_PUBLIC_KEY_ENV,
  type PluginEntitlementPublicKeySource,
} from "./store.js";
export {
  validateIncomingKey,
  isPluginEntitled,
  isValidEd25519PublicKey,
  acceptKeyRequestSchema,
  setPublicKeyRequestSchema,
  verifyEntitlementToken,
  entitlementTokenErrorMessage,
} from "./validation.js";
