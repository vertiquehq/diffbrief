#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
# SPDX-License-Identifier: EUPL-1.2
#
# Download a named artifact from another completed workflow run on this
# repository and unpack it into DEST. Used for CI reuse: a main CI job uploads
# openapi specs or Playwright test-results; diffbrief pulls them instead of
# rebuilding.
#
# Env:
#   REPO            owner/name (required)
#   ARTIFACT_NAME   artifact name (required)
#   DEST            unpack directory (required)
#   EXPECTED_SHA    commit that produced the artifact (required)
#   GH_TOKEN / GITHUB_TOKEN  required for gh api

set -euo pipefail

if [[ -z "${REPO:-}" || -z "${ARTIFACT_NAME:-}" || -z "${DEST:-}" || -z "${EXPECTED_SHA:-}" ]]; then
  echo "download-workflow-artifact: REPO, ARTIFACT_NAME, DEST, and EXPECTED_SHA are required" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

query="repos/${REPO}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=30"
body="$(gh api --paginate --slurp "$query")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
id="$(
  ARTIFACT_NAME="$ARTIFACT_NAME" EXPECTED_SHA="$EXPECTED_SHA" \
    node "$script_dir/pick-artifact.mjs" <<<"$body"
)"

echo "download-workflow-artifact: fetching artifact id=${id} -> ${DEST}"
gh api "repos/${REPO}/actions/artifacts/${id}/zip" > "$tmp/artifact.zip"
mkdir -p "$DEST"
unzip -qo "$tmp/artifact.zip" -d "$DEST"
echo "download-workflow-artifact: unpacked into ${DEST}"
