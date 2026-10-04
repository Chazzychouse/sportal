/** Import boundaries and banned names. See docs/technical-spec.md section 4. */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "packages/domain imports only Effect.",
      severity: "error",
      from: { path: "^packages/domain/" },
      to: { path: "^(apps|packages/api)/" }
    },
    {
      name: "api-imports-only-domain",
      severity: "error",
      from: { path: "^packages/api/" },
      to: { path: "^apps/" }
    },
    {
      name: "nothing-imports-an-app",
      comment: "Apps compose packages; they never import each other.",
      severity: "error",
      from: { path: "^(packages|apps)/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^$1/$2/" }
    },
    {
      name: "provider-payloads-are-private",
      comment: "A provider's or source's wire vocabulary stays inside its folder.",
      severity: "error",
      from: { pathNot: "^apps/hub/src/(provider|source)/([^/]+)/" },
      to: { path: "^apps/hub/src/(provider|source)/[^/]+/[^/]*Payload\\.ts$" }
    },
    {
      name: "only-hub-mode-names-adapters",
      comment:
        "Only HubMode and tests know which concrete providers and sources exist; main.ts names only the database.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/HubMode\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/youtube-tv/|^apps/hub/src/source/Sql[^/]+\\.ts$)"
      },
      to: {
        path: "^apps/hub/src/(provider/[^/]+/|source/youtube-tv/|source/Sql[^/]+\\.ts$|scenario/Scenario(Provider|Source|Clock)\\.ts$)"
      }
    },
    {
      name: "only-main-opens-the-database",
      comment: "The composition root provides the database; stores reach it through SqlClient.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/source/Sql[^/]+\\.ts$|^apps/hub/src/database/)"
      },
      to: { path: "^apps/hub/src/database/" }
    },
    {
      name: "test-game-is-for-tests",
      comment:
        "The test snapshot builder is imported by test files and scenarios, which are test data by nature.",
      severity: "error",
      from: {
        pathNot: "(\\.test\\.tsx?$|^packages/domain/src/Scenario\\.ts$|^packages/domain/src/scenarios/)"
      },
      to: { path: "^packages/domain/src/TestGame\\.ts$" }
    },
    {
      name: "test-hub-config-is-for-tests",
      comment: "HubConfig read from a test's own variables is imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/TestHubConfig\\.ts$" }
    },
    {
      name: "no-junk-drawers",
      comment: "Name a file for the concept it owns.",
      severity: "error",
      from: {},
      to: {
        path: "(^|/)(utils|helpers|common|shared|misc|lib|types|constants|models|interfaces)(/|\\.tsx?$)",
        pathNot: "node_modules"
      }
    },
    {
      name: "no-barrels",
      severity: "error",
      from: {},
      to: { path: "(^|/)index\\.tsx?$", pathNot: "node_modules" }
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] }
  }
}
