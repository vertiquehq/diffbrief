#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
# SPDX-License-Identifier: EUPL-1.2
set -euo pipefail
base_sha="$(git -C "$DIFFBRIEF_BASE" rev-parse HEAD)"
head_sha="$(git -C "$DIFFBRIEF_HEAD" rev-parse HEAD)"
node "$(dirname "$0")/self-review.mjs" "$base_sha" "$head_sha"
