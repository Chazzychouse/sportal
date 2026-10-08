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
      name: "only-main-names-adapters",
      comment:
        "Only main.ts and tests know which concrete providers and sources exist, ESPN's through Espn.ts.",
      severity: "error",
      from: {
        path: "^apps/hub/src/",
        pathNot:
          "(^apps/hub/src/main\\.ts$|\\.test\\.ts$|^apps/hub/src/provider/[^/]+/|^apps/hub/src/source/youtube-tv/)"
      },
      to: {
        path: "^apps/hub/src/(provider/[^/]+/|source/youtube-tv/)"
      }
    },
    {
      name: "espn-has-one-front-door",
      comment: "Outside ESPN's folder and tests, ESPN's layers are reached only through Espn.ts.",
      severity: "error",
      from: { pathNot: "(^apps/hub/src/provider/espn/|\\.test\\.ts$)" },
      to: {
        path: "^apps/hub/src/provider/espn/(EspnProvider|EspnDecoder|FastCast)\\.ts$"
      }
    },
    {
      name: "test-game-is-for-tests",
      comment: "The test snapshot builder is imported by test files and the web's test slate.",
      severity: "error",
      from: {
        pathNot: "(\\.test\\.tsx?$|^apps/web/src/slate/TestSlate\\.ts$)"
      },
      to: { path: "^packages/domain/src/TestGame\\.ts$" }
    },
    {
      name: "test-telemetry-is-for-tests",
      comment: "Logs, spans, and metrics recorded for a test are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/TestTelemetry\\.ts$" }
    },
    {
      name: "test-director-is-for-tests",
      comment: "The Director over a fed provider is imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/hub/src/TestDirector\\.ts$" }
    },
    {
      name: "test-screen-is-for-tests",
      comment: "Screens of the domain's test games, on FOX or nowhere, are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.tsx?$" },
      to: { path: "^packages/domain/src/TestScreen\\.ts$" }
    },
    {
      name: "test-slate-is-for-tests",
      comment: "The web's test slate is imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.tsx?$" },
      to: { path: "^apps/web/src/slate/TestSlate\\.ts$" }
    },
    {
      name: "web-test-screen-is-for-tests",
      comment: "Screens of the test slate's games in the web's tiles are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.tsx?$" },
      to: { path: "^apps/web/src/screen/TestScreen\\.ts$" }
    },
    {
      name: "test-shell-is-for-tests",
      comment: "The shell around a desktop service under test is imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/desktop/src/main/TestShell\\.ts$" }
    },
    {
      name: "test-web-contents-is-for-tests",
      comment: "Fake page contents and navigations are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
      to: { path: "^apps/desktop/src/main/TestWebContents\\.ts$" }
    },
    {
      name: "test-adapter-data-is-for-tests",
      comment:
        "An adapter's recorded payloads, read for tests of other modules, are imported only by test files.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$" },
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
