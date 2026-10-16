# Product branding in the UI (B1a)

The human-visible product name has one source of truth: `PRODUCT_NAME` in
`packages/shared/src/myrmidon-product.ts`, exported through
`@paperclipai/shared`. UI components import that symbol rather than defining a
second constant. Page titles end in the shared name. The regular and production
account-menu variants render their localized About link/version label from the
same shared-name localization resource.

The English and Russian `about.title` strings both include `PRODUCT_NAME`; the
`sidebar.version` localization in both languages does the same. Focused tests in
`ui/src/context/BreadcrumbContext.test.tsx` and
`ui/src/components/SidebarAccountMenu.test.tsx` pin the page-title construction,
About labels in both languages, and version link text/aria-label.

The branding guard in `ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts`
scans visible UI source for vendor branding and checks the shipped page title,
manifest, and icon assets. External product wording is not exempt in first-party
UI copy. Vendor identifiers and compatibility names (package names, HTTP
headers, API paths, storage keys) are not user-visible product copy and remain
unchanged. The MIT attribution in About is the intentional user-visible
exception.

See [the divergence register](../DIVERGENCE.md#track-1--platform) for the B1a
vendor-file inventory and its removal policy.
