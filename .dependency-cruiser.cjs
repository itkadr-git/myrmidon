module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      from: { pathNot: ["^node_modules"] },
      to: { circular: true },
    },
    {
      name: "domain-no-infrastructure",
      severity: "error",
      from: { path: "^server/src/modules/[^/]+/domain" },
      to: {
        path: "^server/src/(modules/[^/]+/(adapters|application)|services|routes)",
      },
    },
    {
      name: "application-no-adapters",
      severity: "error",
      from: { path: "^server/src/modules/[^/]+/application" },
      to: { path: "^server/src/modules/[^/]+/adapters" },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: {
      path: ["node_modules"],
    },
    exclude: "(^|/)\\.(test|spec)\\.[^/]+$",
    reporterOptions: {},
  },
};
