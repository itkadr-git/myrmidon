# Custom Localization Catalog Upload and Validation API

> Русская версия: [Locale-upload.ru](Locale-upload.ru)


The localization catalog upload API enables instance owners and board members to upload custom JSON translation catalogs, validate them against the reference English catalog, and store them per instance with automatic versioning and checksums.

## Upload from the board UI

Open UI 2.0 **Language and formats**, then the custom locale upload section. Enter a locale code (for example, `fr`), select a `.json` catalog, or paste its JSON into the text area. If the locale field is empty when you select a file, the UI uses its filename without `.json` as the locale code. The catalog must be a JSON object of translation keys and values.

Before applying, inspect the validation status and coverage against the English UI catalog. The preview shows matched, missing, and extra keys with their existing and proposed values; filter by status or search for a key. Invalid catalogs cannot be applied. When the preview looks right, select **Apply**. The catalog is applied in the current browser session immediately, and the selected language switches without restarting the app. The language switcher also lists custom locales registered in this session.

The UI attempts to upload the catalog to the server, but currently falls back to applying it only in the browser if the upload fails. A success message therefore does **not** prove that the catalog was saved on the server; verify persistence with `GET /api/myrmidon/locales/custom/:locale` if required. Client-side custom catalog entries are not guaranteed to survive a page reload.

## Endpoints

### 1. Upload Catalog
- **Path**: `POST /api/myrmidon/locales/upload` (alias: `POST /api/myrmidon/locale-upload`)
- **Authorization**: Board members only (`assertBoard`)
- **Content-Type**: `multipart/form-data` (field `file` or `catalog`) or `application/json`
- **Body parameters (JSON)**:
  - `locale`: target locale code (e.g. `de`, `fr`, `es-mx`)
  - `catalog`: JSON dictionary of translation keys
  - `dryRun` (optional, boolean): validate without persisting
  - `strict` (optional, boolean): require all base keys to be present
- **Response**: `UploadLocaleResult` (status 200) or error with validation diff report (status 400)

### 2. Validate Catalog (Dry-run Validation)
- **Path**: `POST /api/myrmidon/locales/validate`
- **Authorization**: Board members only (`assertBoard`)
- **Body parameters**: same as upload
- **Response**: 200 with `{ valid: true, report, warnings }` or 400 with `{ error: "CATALOG_VALIDATION_FAILED", report, errors, warnings }`

### 3. List Custom Catalogs
- **Path**: `GET /api/myrmidon/locales/custom`
- **Authorization**: Authenticated users
- **Response**: list of summaries including version, upload date, key count, and checksum

### 4. Get Catalog
- **Path**: `GET /api/myrmidon/locales/custom/:locale`
- **Authorization**: Authenticated users
- **Response**: full stored custom locale object with catalog payload

### 5. Delete Catalog
- **Path**: `DELETE /api/myrmidon/locales/custom/:locale`
- **Authorization**: Board members only (`assertBoard`)
- **Response**: `{ deleted: true, locale }` (status 200) or 404

## Validation Rules
- Root element must be an object (nested keys flattened into dot notation, e.g. `app.title`).
- Placeholders: all `{var}` or `{{var}}` placeholders must match the base English reference catalog.
- Disallowed content: HTML script tags, event handlers (`onload=`, `onclick=`), and javascript/data URIs are rejected.
- String length: translation strings cannot exceed 4000 characters.
