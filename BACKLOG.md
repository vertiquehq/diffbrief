<!--
SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
SPDX-License-Identifier: EUPL-1.2
-->

# Backlog

Ideas inspired by [human-review](https://github.com/victorrentea/human-review) that fit
diffbrief’s product (sticky PR comment + artifact, deterministic, no LLM) but are not
in the first cut.

## Likely next

- **HTML review page in the artifact** — one self-contained `review.html` with the
  verdict band, OpenAPI visual diff (`oasdiff --format html`), and the module graph SVG,
  linked from the sticky comment. human-review’s “one page, one question per tab”.
- **Reuse CI compile outputs** — head specs from the main build job; base specs cached by
  merge-base SHA. Removes the duplicate Maven compile when the consumer already built.
- **Narrow `-pl`** — only OpenAPI modules touched by the three-dot diff (+ `-am`).
- **Parallel base/head builds** — cut wall clock roughly in half when both sides compile.

## Later / optional producers

- **Focus diagrams** — module Mermaid already drops context-to-context edges; add optional
  “focus N” captions listing only touched modules (human-review’s PlantUML `--focus`).
- **CODEOWNERS delta** — who must approve the touched paths.
- **Complexity / size delta** — LOC or cyclomatic only where cheap and deterministic.
- **Custom PlantUML / architecture diagram diff** — as a `command` producer, not a built-in.

## Deliberately not in scope

- LLM review rounds, cost tabs, feature videos, Code City, editor deep-links — those are
  human-review’s skill surface, not a shared CI action.
- A second home-grown OpenAPI classifier beside oasdiff — human-review’s eval dropped
  theirs; we stay on oasdiff alone.
