<!--
SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
SPDX-License-Identifier: EUPL-1.2
-->

# diffbrief

Sticky pull-request comments for **structural** diffs: Maven reactor graphs, OpenAPI changelogs (via a pinned `oasdiff` CLI), and custom command producers. Deterministic. No LLM in the diff path.

This repository is a **composite GitHub Action**. Consumer repositories keep a short caller workflow and a JSON config. They do not copy the scripts.

## Status

The repository starts **private** so it can be exercised from other private repositories in the same GitHub organization. A **public** repository cannot use a private action. Flip this repository to public before wiring it into a public consumer (for example Vertique).

Organization setting required while private: allow Actions workflows to access this private repository (org → Actions → General → Access).

## Quick start

1. Add `.github/diffbrief.json` (see [`examples/`](examples/)).
2. Add a workflow that checks out the PR head (`fetch-depth: 0`), sets up whatever toolchains your producers need (JDK, Node, …), then calls the action:

```yaml
- uses: vertiquehq/diffbrief@v1
  with:
    config: .github/diffbrief.json
    token: ${{ github.token }}
```

The job needs `permissions: pull-requests: write` (and `contents: read`). Prefer `pull_request`, never `pull_request_target`. There is intentionally no `paths:` filter: a later push that drops the last relevant file must still run so a stale comment can be removed.

Full caller skeleton: [`examples/caller-workflow.yml`](examples/caller-workflow.yml).

## Configuration

JSON only (no extra runtime dependencies). Missing file → Maven + OpenAPI defaults.

| Field | Meaning |
| --- | --- |
| `relevant` | Globs (`*`, `**`, `?`). If none of the changed paths match, builds are skipped and an existing comment is deleted. |
| `producers` | Ordered list. Built-ins below, plus `command`. |
| `failOn` | `breaking` (default) or `never`. Failure happens only after the comment, summary, and artifact exist. |
| `marker` / `title` / `artifact` | Sticky-comment marker, heading, and artifact name. |
| `nodeCap` | Inline Mermaid node budget (default 60). Over that → DOT (+ SVG when `dot` is on `PATH`). |

Built-in producers: `maven-reactor`, `openapi`, `asyncapi`, `migrations`, `i18n`, `dependencies`, `sarif`, `playwright`, `entry-complexity`. Enabling a producer without an explicit `relevant` list also adds sensible path globs. See [`examples/full-stack.json`](examples/full-stack.json) and [`examples/reuse-caller-workflow.yml`](examples/reuse-caller-workflow.yml).

### `maven-reactor`

Parses `pom.xml` files without running Maven. Uniform reactor version bumps fold into one `Reactor version:` line and stay silent when that is the only change. Diagram edges are drawn only when at least one endpoint is added, removed, or changed.

### `openapi`

| Option | Meaning |
| --- | --- |
| `discover: "swagger-outputFileName"` | Find modules whose pom sets that output name, then `./mvnw … compile`. |
| `buildCommand` | Shell command run in each checkout instead (or as well when discover is unset). |
| `skipBuild: true` | Collect existing files only. |
| `specsGlob` | `find`-style glob under the checkout (default `**/target/classes/openapi.yaml`). |
| `specs` | Explicit relative paths; skips glob discovery. |
| `oasdiffVersion` / `oasdiffSha256` | Pin the CLI release (checksum verified before extract). |

The oasdiff **GitHub Action is not used**, so specs are not uploaded to oasdiff.com.

Set `cacheSpecs: true` (or action input `cache-specs: true`) to cache collected specs by head SHA and merge-base SHA. Pass `head-specs-dir` / `base-specs-dir` or `reuse-*-artifact` to skip the Maven compile when CI already produced the YAMLs.

### `asyncapi`

Same idea as OpenAPI, via the AsyncAPI CLI (`asyncapi diff`). oasdiff does not support AsyncAPI. Put `asyncapi` on `PATH` (or set `ASYNCAPI_BIN`). Default globs: `**/asyncapi.yaml`, `**/asyncapi.yml`, `**/asyncapi.json`.

### `migrations`

Compares Flyway/Liquibase-style files by path and content hash (no database). Editing an already-versioned `V*` file is a breaking finding.

### `i18n`

Message key add/remove/change in `.properties` and nested JSON locale files. Removed keys are breaking by default.

### `dependencies`

Maven reactor **external** dependency version moves (needs reactor models), plus auto-detected lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`. Override with `lockfiles: [...]`.

### `sarif`

Diff two SARIF files and list findings introduced on head. **PMD:** use the official PMD GitHub Action (or `mvn pmd:pmd` + SARIF conversion) to produce base/head reports, then point `baseSarif` / `headSarif` here. Diffbrief does not run PMD. CPD duplication has no SARIF yet — use a `command` producer if you need it. Details: [`BACKLOG.md`](BACKLOG.md).

### `playwright`

Does **not** run Playwright. Finds videos/traces under `test-results` / `playwright-report` (or `resultsDirs`), copies them into the diffbrief artifact under `playwright/`, and lists them in the sticky comment. Pair with action input `reuse-playwright-artifact` when another job uploaded the results.

### `entry-complexity`

Ranks entry points by cognitive complexity of the reachable flow (before → after), inspired by human-review’s Complexity tab. Built-in **Vertique** detectors only: JAX-RS, `@McpTool`, `@KafkaSource`, `@DelayedJobHandlerMethod`. Spring and others are opt-in packs — see [`contrib/spring.json`](contrib/spring.json) and [`docs/contributing-detectors.md`](docs/contributing-detectors.md). Never breaking. Typed service-contract calls are followed across the event-bus proxy; raw bus addresses are not.

### `command`

Runs a script from the head checkout. Environment:

- `DIFFBRIEF_BASE`, `DIFFBRIEF_HEAD` — checkout paths  
- `DIFFBRIEF_FRAGMENT_DIR` — write `fragment.md` and optional `breaking` (`true` / `false`)

```json
{ "type": "command", "id": "Terraform plan", "run": "scripts/diffbrief-terraform.sh" }
```

## Local use

From a clone of this action repository, against any Maven/OpenAPI consumer checkout:

```bash
git worktree add --detach /tmp/diffbrief-base "$(git merge-base <base-tip> HEAD)"

CHECKOUT=/tmp/diffbrief-base SPECS_OUT=/tmp/out/base-specs DISCOVER=swagger-outputFileName \
  bash /path/to/diffbrief/scripts/build-specs.sh
CHECKOUT="$PWD" SPECS_OUT=/tmp/out/head-specs DISCOVER=swagger-outputFileName \
  bash /path/to/diffbrief/scripts/build-specs.sh

OASDIFF_BIN=oasdiff node /path/to/diffbrief/scripts/run.mjs \
  --base /tmp/diffbrief-base --head "$PWD" \
  --base-specs /tmp/out/base-specs --head-specs /tmp/out/head-specs \
  --out /tmp/out --pr 1 --repo owner/name --dry-run \
  --config /path/to/diffbrief/examples/maven-openapi.json
```

## Tests

```bash
node --test tests/*.test.mjs
```

`UPDATE_GOLDEN=1` rewrites fixture expectations under `fixtures/`. The real `oasdiff` cases run when `oasdiff` is on `PATH` (or `OASDIFF_BIN` points at it).

## Design notes (human-review)

diffbrief is a CI sticky-comment action, not a clone of
[human-review](https://github.com/victorrentea/human-review). That project’s review page
still shapes several choices here:

- **One question per section** — headings ask what the reviewer came for
  (`Did the API contract move?`, `What moved in the module graph?`).
- **Verdict first** — a one-line oasdiff seal (compatible / not / did not move) before the
  details, the way their API tab opens with a band.
- **One differ** — oasdiff only; no second home-grown OpenAPI classifier (see their
  [differ eval](https://github.com/victorrentea/human-review/blob/main/skills/human-review/reference/openapi-differ-eval.md)).
- **No upload** — never `oasdiff --open`; external `$ref` fetches are disabled.
- **Checked, not forgotten** — when a producer runs and finds nothing beside other
  changes, the section can say it was checked (full “unchanged only” runs stay silent so
  the sticky comment is removed).

Larger ideas that still fit the product live in [`BACKLOG.md`](BACKLOG.md).

## Runtime cost

On a warm Maven cache for a Vertique-sized OpenAPI compile (eight example modules), one side was about **25 seconds**. A relevant PR builds **base and head**, so plan on roughly **~50 seconds of compile** plus checkout, graph diff, oasdiff, and the comment API — usually **under a couple of minutes** when the cache hits. Irrelevant path changes skip the builds (classify + comment reconcile only). A cold dependency cache is dominated by Maven downloads and can be much longer; the example caller uses a 40-minute timeout as a safety margin.

## Security notes

- Fork PRs get a read-only `GITHUB_TOKEN`; the comment write is skipped, and the job summary/artifact remain.
- Comparison base is the **merge base**, not the moving base-branch tip.
- Do not switch the caller to `pull_request_target`.

## License

[European Union Public Licence v1.2](LICENSES/EUPL-1.2.txt).
