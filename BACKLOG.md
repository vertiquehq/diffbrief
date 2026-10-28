<!--
SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
SPDX-License-Identifier: EUPL-1.2
-->

# Backlog

## Done in-tree (producers)

| Producer | What it does |
| --- | --- |
| `migrations` | Flyway/Liquibase file delta; edited `V*` files are breaking |
| `i18n` | Message key add/remove/change in `.properties` / JSON locales |
| `dependencies` | Maven reactor externals + `package-lock.json` top-level packages |
| `asyncapi` | `asyncapi diff` (CLI); oasdiff does **not** support AsyncAPI |
| `sarif` | New SAST findings vs base (feeds from PMD/CodeQL/SpotBugs SARIF) |
| `playwright` | Package recorded videos/traces into the artifact + comment links |
| `dependencies` | Maven externals + npm / yarn / pnpm / Cargo lockfiles |
| `entry-complexity` | Cognitive complexity delta per JAX-RS / MCP / Kafka / job entry (Vertique pack; Spring via contrib) |

## CI artifact reuse (supported)

- Action inputs: `cache-specs`, `head-specs-dir`, `base-specs-dir`, `reuse-head-artifact`, `reuse-base-artifact`, `reuse-playwright-artifact`
- Config: `openapi.cacheSpecs: true`
- Helper: `scripts/download-workflow-artifact.sh` + SHA-keyed `actions/cache` for OpenAPI trees

## SAST / PMD — investigation notes

**PMD itself** (rule violations):

- Official [`pmd/pmd-github-action`](https://github.com/pmd/pmd-github-action) emits **SARIF**, can analyze only modified files, can upload for GitHub Code Scanning annotations.
- That is the right input for diffbrief’s `sarif` producer: run PMD (or SpotBugs via scarfco→SARIF, CodeQL, Semgrep) on base and head, then diff.
- Diffbrief does **not** vendor PMD — running it twice is the consumer CI’s job (or reuse artifacts).

**PMD CPD** (copy-paste duplication):

- Useful as a **delta** (duplication introduced by the PR), not as a raw total.
- CPD **SARIF is still missing** ([pmd#4632](https://github.com/pmd/pmd/issues/4632)); output is XML/CSV.
- Options: a `command` producer that wraps CPD XML → fragment, or something like [duplicate-code-cross-check](https://github.com/astubbs/duplicate-code-cross-check) outside diffbrief.
- Not a built-in until CPD has a stable machine format we can parse without Maven.

**Other SAST that plugs in via `sarif` today:** CodeQL, Semgrep SARIF, SpotBugs→SARIF, ESLint SARIF, etc.

## Generated architecture / sequence from traces

human-review builds PlantUML sequence diffs from **recorded test traces** (genseq), then projects C2 containers from those sequences. That needs:

1. A project-specific tracer / test tagging convention  
2. Stored `*.genseq.json` / `.puml` / `.diff.svg` assets  
3. Often Docker + the app under test  

**diffbrief fit:** a `command` producer (or future `traces` type) that copies a configured `tracesDir` of `*.diff.svg` / markdown into the fragment — it should **not** run the app. Documented pattern:

```json
{
  "type": "command",
  "id": "Sequences from traces",
  "run": "scripts/diffbrief-traces.sh"
}
```

where the script reads CI-produced assets under `DIFFBRIEF_HEAD` / artifact download.

## Likely next

- HTML review page in the artifact (verdict + sections + embedded media)
- JavaParser / symbol-solver engine for exact nesting and overload binding
- Optional Vertique-aware edges for raw `EventBusClient` address literals
- Filter Playwright media by changed test files / `@diffbrief` tags
- Gradle lockfile / `pnpm-lock` importers-only mode
- Optional `traces` built-in once a minimal asset layout is frozen
- Same-workflow `actions/download-artifact` helper (today: cross-run via `gh api`)

## Deliberately not in scope

- LLM review rounds, cost tabs, Code City, editor deep-links (human-review skill)
- A second home-grown OpenAPI classifier beside oasdiff
- Running PMD/CPD inside the composite action by default
