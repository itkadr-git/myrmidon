// myrmidon(OPE-13019): barrel for the external-connector catalog contract.
// Keep this file a pure re-export of the catalog module; add new files in
// this directory only when the contract genuinely splits into a second
// domain (e.g. grants, journal) in a later slice. OPE-13026 adds the grants
// (policy) and journal (invocation audit) contract as the second domain.

export * from "./catalog.js";
export * from "./policy.js";
