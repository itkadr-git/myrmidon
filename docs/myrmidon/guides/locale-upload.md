# Custom Localization Catalog Upload and Validation API

The localization catalog upload API enables instance owners and board members to upload custom JSON translation catalogs, validate them against the reference English catalog, and store them per instance with automatic versioning and checksums.

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
