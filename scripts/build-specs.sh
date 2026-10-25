#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
# SPDX-License-Identifier: EUPL-1.2
#
# Collect OpenAPI documents from a checkout into SPECS_OUT.
#
# Modes (env):
#   DISCOVER=swagger-outputFileName  — find modules with that pom marker,
#     then compile them with ./mvnw (unless BUILD_COMMAND is set or SKIP_BUILD=1).
#   BUILD_COMMAND                    — run this shell command in CHECKOUT
#     before collecting specs (overrides the default mvnw compile).
#   SPECS_GLOB                       — find(1) -path glob relative to CHECKOUT
#     (default **/target/classes/openapi.yaml). Specs are keyed by the path
#     stripped of the trailing /openapi.yaml (or the file basename for free
#     layout).
#   SKIP_BUILD=1                     — collect existing files only.
#   SPECS_LIST                       — newline-separated relative paths; when
#     set, those files are copied and discovery/glob find is skipped.

set -euo pipefail

if [[ -z "${CHECKOUT:-}" ]]; then
  echo "build-specs: CHECKOUT is required" >&2
  exit 1
fi
if [[ -z "${SPECS_OUT:-}" ]]; then
  echo "build-specs: SPECS_OUT is required" >&2
  exit 1
fi

SPECS_GLOB="${SPECS_GLOB:-**/target/classes/openapi.yaml}"
DISCOVER="${DISCOVER:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"

mkdir -p "$SPECS_OUT"

resolve_build_command() {
  if [[ -n "${BUILD_COMMAND:-}" ]]; then
    printf '%s' "$BUILD_COMMAND"
    return 0
  fi
  if [[ -n "${BUILD_COMMAND_FILE:-}" && -f "$BUILD_COMMAND_FILE" ]]; then
    local text
    text="$(cat "$BUILD_COMMAND_FILE")"
    if [[ -n "$text" ]]; then
      printf '%s' "$text"
    fi
  fi
}

run_build() {
  if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "build-specs: skip build"
    return 0
  fi
  local cmd
  cmd="$(resolve_build_command || true)"
  if [[ -n "$cmd" ]]; then
    echo "build-specs: ${cmd}"
    ( cd "$CHECKOUT" && bash -lc "$cmd" )
    return 0
  fi
  if [[ "$DISCOVER" == "swagger-outputFileName" ]]; then
    local pl=""
    while IFS= read -r pom; do
      if grep -q '<outputFileName>openapi</outputFileName>' "$pom"; then
        local dir
        dir="$(dirname "$pom")"
        dir="${dir#"$CHECKOUT"/}"
        if [[ -n "$pl" ]]; then
          pl="${pl},${dir}"
        else
          pl="$dir"
        fi
      fi
    done < <(find "$CHECKOUT" -name pom.xml -not -path '*/target/*' -not -path '*/.git/*' -not -path '*/diffbrief-out/*' | LC_ALL=C sort)

    if [[ -z "$pl" ]]; then
      echo "build-specs: no module generates openapi.yaml"
      return 0
    fi
    echo "build-specs: ./mvnw -ntp -B -DskipTests -Darchetype.test.skip=true -pl ${pl} -am compile"
    ( cd "$CHECKOUT" && ./mvnw -ntp -B -DskipTests -Darchetype.test.skip=true -pl "$pl" -am compile )
    return 0
  fi
  if [[ -z "${BUILD_COMMAND:-}" && -z "$DISCOVER" ]]; then
    echo "build-specs: no build configured; collecting existing specs only"
  fi
}

copy_spec() {
  local spec="$1"
  local rel="${spec#"$CHECKOUT"/}"
  local key
  if [[ "$rel" == */openapi.yaml || "$rel" == */openapi.yml ]]; then
    key="${rel%/*}"
  else
    key="${rel%.*}"
  fi
  mkdir -p "$SPECS_OUT/$key"
  local dest_name="openapi.yaml"
  if [[ "$rel" == *.yml ]]; then
    dest_name="openapi.yml"
  fi
  # Always store as openapi.yaml so the differ keys consistently.
  cp "$spec" "$SPECS_OUT/$key/openapi.yaml"
  echo "build-specs: collected ${rel} -> ${key}/openapi.yaml"
}

run_build

if [[ -n "${SPECS_LIST_FILE:-}" && -s "$SPECS_LIST_FILE" ]]; then
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if [[ ! -f "$CHECKOUT/$rel" ]]; then
      echo "build-specs: missing listed spec $rel" >&2
      exit 1
    fi
    copy_spec "$CHECKOUT/$rel"
  done < "$SPECS_LIST_FILE"
  exit 0
fi
if [[ -n "${SPECS_LIST:-}" ]]; then
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if [[ ! -f "$CHECKOUT/$rel" ]]; then
      echo "build-specs: missing listed spec $rel" >&2
      exit 1
    fi
    copy_spec "$CHECKOUT/$rel"
  done <<< "$SPECS_LIST"
  exit 0
fi

# find(1) -path wants a path pattern; accept **/… by stripping the leading **/
find_pattern="$SPECS_GLOB"
if [[ "$find_pattern" == \*\*/* ]]; then
  find_pattern="${find_pattern#**/}"
fi

while IFS= read -r spec; do
  copy_spec "$spec"
done < <(find "$CHECKOUT" -path "*/${find_pattern}" -not -path '*/.git/*' -not -path '*/diffbrief-out/*' 2>/dev/null | LC_ALL=C sort)
