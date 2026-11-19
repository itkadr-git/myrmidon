// myrmidon(OPE-13019): barrel for the external-connector catalog contract.
// Keep this file a pure re-export of the catalog module; add new files in
// this directory only when the contract genuinely splits into a second
// domain (e.g. grants, journal) in a later slice.

export * from "./catalog.js";
