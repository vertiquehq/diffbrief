// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff third-party dependency versions between two checkouts.
 *
 * Sources (any combination):
 * - Maven reactor models already extracted by the maven-reactor producer
 * - package-lock.json (npm lockfileVersion 2/3 `packages` map)
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { cmp, inlineCode } from './util.mjs';

function collectMavenExternal(model) {
  const map = new Map();
  if (!model?.modules) return map;
  const reactorIds = new Set(model.modules.map((m) => m.id));
  for (const mod of model.modules) {
    for (const dep of mod.externalDependencies ?? []) {
      if (reactorIds.has(dep.id)) continue;
      const version = dep.version || 'managed';
      const prev = map.get(dep.id);
      if (!prev) map.set(dep.id, version);
      else if (prev !== version) map.set(dep.id, `${prev} | ${version}`);
    }
  }
  return map;
}

function collectNpmLock(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const packages = json.packages || {};
  for (const [rel, meta] of Object.entries(packages)) {
    if (!rel) continue;
    if (!rel.startsWith('node_modules/')) continue;
    const rest = rel.slice('node_modules/'.length);
    if (!rest || rest.includes('/node_modules/')) continue;
    if (meta?.version) map.set(rest, meta.version);
  }
  return map;
}

function diffMaps(base, head) {
  const keys = [...new Set([...base.keys(), ...head.keys()])].sort(cmp);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of keys) {
    const b = base.get(key);
    const h = head.get(key);
    if (b != null && h == null) removed.push({ id: key, from: b, to: null });
    else if (b == null && h != null) added.push({ id: key, from: null, to: h });
    else if (b != null && h != null && b !== h) changed.push({ id: key, from: b, to: h });
  }
  return { added, removed, changed };
}

function renderSection(title, diff) {
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) return '';
  const lines = [`### ${title}`, '', '| Dependency | Change |', '| --- | --- |'];
  for (const row of diff.added) lines.push(`| ${inlineCode(row.id)} | added \`${row.to}\` |`);
  for (const row of diff.removed) lines.push(`| ${inlineCode(row.id)} | removed (was \`${row.from}\`) |`);
  for (const row of diff.changed) lines.push(`| ${inlineCode(row.id)} | \`${row.from}\` → \`${row.to}\` |`);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ baseModel?: object, headModel?: object, baseRoot: string, headRoot: string, lockfiles?: string[] }} options
 */
export function diffDependencies(options = {}) {
  const lockfiles = options.lockfiles?.length ? options.lockfiles : ['package-lock.json'];
  const parts = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  if (options.baseModel && options.headModel) {
    const d = diffMaps(collectMavenExternal(options.baseModel), collectMavenExternal(options.headModel));
    const section = renderSection('Maven external dependencies', d);
    if (section) {
      parts.push(section);
      added += d.added.length;
      removed += d.removed.length;
      changed += d.changed.length;
    }
  }

  for (const rel of lockfiles) {
    const baseFile = path.join(options.baseRoot, rel);
    const headFile = path.join(options.headRoot, rel);
    if (!existsSync(baseFile) && !existsSync(headFile)) continue;
    if (!rel.endsWith('package-lock.json')) continue;
    const d = diffMaps(collectNpmLock(baseFile), collectNpmLock(headFile));
    const section = renderSection(rel, d);
    if (section) {
      parts.push(section);
      added += d.added.length;
      removed += d.removed.length;
      changed += d.changed.length;
    }
  }

  return {
    markdown: parts.join('\n'),
    breaking: false,
    checked: true,
    counts: { added, removed, changed },
  };
}
