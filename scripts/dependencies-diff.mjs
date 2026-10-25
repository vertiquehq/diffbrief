// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff third-party dependency versions between two checkouts.
 *
 * Sources (any combination):
 * - Maven reactor models already extracted by the maven-reactor producer
 * - package-lock.json (npm lockfileVersion 2/3)
 * - yarn.lock (classic v1 and Berry-style version lines)
 * - pnpm-lock.yaml (packages: map keys)
 * - Cargo.lock ([[package]] tables)
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { cmp, inlineCode } from './util.mjs';

export const DEFAULT_LOCKFILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
];

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

export function collectNpmLock(file) {
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

/** yarn.lock classic (`"name@version":` + `  version "x"`) and Berry (`version: x`). */
export function collectYarnLock(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  const text = readFileSync(file, 'utf8');
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(' ') && line.includes('@')) {
      current = line
        .replace(/:$/, '')
        .split(',')
        .map((part) => part.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      continue;
    }
    const classic = /^\s+version\s+"([^"]+)"/.exec(line);
    const berry = /^\s+version:\s+(.+)$/.exec(line);
    const version = classic?.[1] ?? berry?.[1]?.replace(/^"|"$/g, '').trim();
    if (!version || current.length === 0) continue;
    for (const entry of current) {
      const name = yarnName(entry);
      if (name) map.set(name, version);
    }
    current = [];
  }
  return map;
}

function yarnName(entry) {
  // name@npm:^1.0.0 | @scope/name@1.0.0 | name@1.0.0
  if (entry.startsWith('@')) {
    const at = entry.indexOf('@', 1);
    return at === -1 ? entry : entry.slice(0, at);
  }
  const at = entry.indexOf('@');
  return at === -1 ? entry : entry.slice(0, at);
}

/** pnpm-lock.yaml — keys under packages: like /lodash@4.17.21 or lodash@4.17.21. */
export function collectPnpmLock(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  const text = readFileSync(file, 'utf8');
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(raw) && !raw.startsWith(' ')) {
      inPackages = false;
    }
    if (!inPackages) continue;
    const match = /^\s{2}['"]?\/?(@?[^'@\s/]+(?:\/[^'@\s/]+)?)[@/]([^'@\s:]+)['"]?:/.exec(raw);
    if (!match) continue;
    map.set(match[1], match[2]);
  }
  return map;
}

/** Cargo.lock — [[package]] name/version pairs (direct + transitive). */
export function collectCargoLock(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  const text = readFileSync(file, 'utf8');
  let name = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[[package]]') {
      name = null;
      continue;
    }
    const n = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (n) {
      name = n[1];
      continue;
    }
    const v = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (v && name) {
      map.set(name, v[1]);
      name = null;
    }
  }
  return map;
}

export function collectLockfile(file) {
  const base = path.basename(file);
  if (base === 'package-lock.json') return collectNpmLock(file);
  if (base === 'yarn.lock') return collectYarnLock(file);
  if (base === 'pnpm-lock.yaml' || base === 'pnpm-lock.yml') return collectPnpmLock(file);
  if (base === 'Cargo.lock') return collectCargoLock(file);
  return new Map();
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

function resolveLockfiles(baseRoot, headRoot, configured) {
  if (configured?.length) return configured;
  return DEFAULT_LOCKFILES.filter(
    (rel) => existsSync(path.join(baseRoot, rel)) || existsSync(path.join(headRoot, rel)),
  );
}

/**
 * @param {{ baseModel?: object, headModel?: object, baseRoot: string, headRoot: string, lockfiles?: string[] }} options
 */
export function diffDependencies(options = {}) {
  const lockfiles = resolveLockfiles(options.baseRoot, options.headRoot, options.lockfiles);
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
    const d = diffMaps(collectLockfile(baseFile), collectLockfile(headFile));
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
