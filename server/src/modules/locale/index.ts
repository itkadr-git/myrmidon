// myrmidon(1.7 LOCALE-UPLOAD / OPE-12117): public surface of the locale module.
export { localeModuleRoutes } from "./routes.js";
export {
  createLocaleModuleService,
  loadBaseEnglishCatalog,
  resetBaseCatalogCache,
  UPLOAD_ALLOWED_LOCALES,
} from "./service.js";
export type {
  CurrentLocaleResponse,
  LocaleModuleService,
  LocaleModuleServiceOptions,
  UploadLocalePayload,
  UploadLocaleResponse,
} from "./service.js";
