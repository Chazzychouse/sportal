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
      to: { path: "^apps/hub/src/(provider|source)/[^/]+/([^/]*Payload|FastCastMessage)\\.ts$" }
    },
    {
      name: "only-hub-mode-names-adapters",
      comment:
        "Only HubMode, the corpus command's composition, and tests, TestFeed and TestCorpus among them, know which concrete providers and sources exist; main.ts names only the database.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/HubMode\\.ts$|^apps/hub/src/corpus/corpus\\.ts$|^apps/hub/src/TestFeed\\.ts$|^apps/hub/src/corpus/TestCorpus\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/youtube-tv/)"
      },
      to: {
        path: "^apps/hub/src/(provider/[^/]+/|source/youtube-tv/|scenario/Scenario(Provider|Source|Clock)\\.ts$)"
      }
    },
    {
      name: "only-main-opens-the-database",
      comment:
        "The composition root provides the database; stores reach it through SqlClient. The feed log opens its own file; the game history only migrates its tables; TestFeed and TestCorpus keep a test's feed log in memory.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/source/ChannelStore\\.ts$|^apps/hub/src/Database\\.ts$|^apps/hub/src/FeedLog\\.ts$|^apps/hub/src/GameHistory\\.ts$|^apps/hub/src/TestFeed\\.ts$|^apps/hub/src/corpus/TestCorpus\\.ts$)"
      },
      to: { path: "^apps/hub/src/Database\\.ts$" }
    },
    {
      name: "test-game-is-for-tests",
      comment:
        "The test snapshot builder is imported by test files, the web's test slate, and scenarios, which are test data by nature.",
      severity: "error",
      from: {
        pathNot:
          "(\\.test\\.tsx?$|^apps/web/src/slate/TestSlate\\.ts$|^apps/hub/src/scenario/(ScenarioScript\\.ts|written/))"
      },
      to: { path: "^packages/domain/src/TestGame\\.ts$" }
    },
    {
      name: "test-hub-config-is-for-tests",
      comment: "HubConfig read from a test's own variables is imported only by test files and TestCorpus.",
      severity: "error",
      from: { pathNot: "(\\.test\\.ts$|^apps/hub/src/corpus/TestCorpus\\.ts$)" },
      to: { path: "^apps/hub/src/TestHubConfig\\.ts$" }
    },
    {
      name: "test-telemetry-is-for-tests",
      comment: "Logs, spans, and metrics recorded for a test are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/TestTelemetry\\.ts$" }
    },
    {
      name: "test-database-is-for-tests",
      comment: "An in-memory or scratch SQLite database is imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/TestDatabase\\.ts$" }
    },
    {
      name: "test-feed-is-for-tests",
      comment:
        "The snapshot feed set up for a test, and what a decode reads in it, are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/TestFeed\\.ts$" }
    },
    {
      name: "test-corpus-is-for-tests",
      comment: "Corpus days set up for a test, over a feed log in memory, are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/corpus/TestCorpus\\.ts$" }
    },
    {
      name: "test-snapshot-feed-is-for-tests",
      comment:
        "The snapshot feed, a provider of our own deliveries, is imported only by test files and TestFeed.",
      severity: "error",
      from: { pathNot: "(\\.test\\.ts$|^apps/hub/src/TestFeed\\.ts$)" },
      to: { path: "^apps/hub/src/TestSnapshotFeed\\.ts$" }
    },
    {
      name: "test-adapter-data-is-for-tests",
      comment:
        "An adapter's recorded payloads, read for tests of other modules, are imported only by test files and TestCorpus.",
      severity: "error",
      from: { pathNot: "(\\.test\\.ts$|^apps/hub/src/corpus/TestCorpus\\.ts$)" },
      to: { path: "^apps/hub/src/(provider/espn/TestEspn|source/youtube-tv/TestYouTubeTv)\\.ts$" }
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
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"] }
  }
}
