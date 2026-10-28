// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff message keys in .properties and flat/nested .json locale files.
 *
 * Reports keys added, removed, or whose values changed. Removal of a key is
 * treated as breaking when breakOnRemovedKeys is true (default).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { matchGlob } from './config.mjs';
import { cmp, inlineCode } from './util.mjs';

export const DEFAULT_I18N_GLOBS = [
  '**/messages*.properties',
  '**/i18n/**/*.properties', '**/i18n/**/*.json',
  '**/locales/**/*.properties', '**/locales/**/*.json',
  '**/lang/**/*.properties', '**/lang/**/*.json',
];

function walkFiles(root, globs, listDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = listDir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of [...entries].map((item) => (typeof item === 'string' ? item : item.name)).sort(cmp)) {
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === '.git' || entry === 'target' || entry === 'node_modules') continue;
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (globs.some((g) => matchGlob(g, rel))) found.push(rel);
    }
  };
  walk(root);
  return found;
}

export function parseProperties(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    let sep = -1;
    if (eq === -1) sep = colon;
    else if (colon === -1) sep = eq;
    else sep = Math.min(eq, colon);
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

function flattenJson(value, prefix, out) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    out.set(prefix || '.', value == null ? '' : String(value));
    return;
  }
  const keys = Object.keys(value).sort(cmp);
  if (keys.length === 0 && prefix) out.set(prefix, '{}');
  for (const key of keys) {
    const next = prefix ? `${prefix}.${key}` : key;
    flattenJson(value[key], next, out);
  }
}

export function parseMessageFile(filePath, text) {
  if (filePath.endsWith('.json')) {
    const out = new Map();
    flattenJson(JSON.parse(text), '', out);
    return out;
  }
  return parseProperties(text);
}

function loadBundle(root, rel, listDir) {
  void listDir;
  const text = readFileSync(path.join(root, rel), 'utf8');
  return parseMessageFile(rel, text);
}

/**
 * @returns {{ markdown: string, breaking: boolean, checked: boolean }}
 */
export function diffI18n(baseRoot, headRoot, options = {}) {
  const globs = options.globs?.length ? options.globs : DEFAULT_I18N_GLOBS;
  const listDir = options.listDir ?? readdirSync;
  const breakOnRemovedKeys = options.breakOnRemovedKeys !== false;
  const baseFiles = new Set(walkFiles(baseRoot, globs, listDir));
  const headFiles = new Set(walkFiles(headRoot, globs, listDir));
  const files = [...new Set([...baseFiles, ...headFiles])].sort(cmp);

  const added = [];
  const removed = [];
  const changed = [];

  for (const file of files) {
    const inBase = baseFiles.has(file);
    const inHead = headFiles.has(file);
    if (inBase && !inHead) {
      removed.push({ file, key: '*' });
      continue;
    }
    if (!inBase && inHead) {
      added.push({ file, key: '*' });
      continue;
    }
    const baseMap = loadBundle(baseRoot, file, listDir);
    const headMap = loadBundle(headRoot, file, listDir);
    const keys = [...new Set([...baseMap.keys(), ...headMap.keys()])].sort(cmp);
    for (const key of keys) {
      const b = baseMap.has(key);
      const h = headMap.has(key);
      if (b && !h) removed.push({ file, key });
      else if (!b && h) added.push({ file, key });
      else if (b && h && baseMap.get(key) !== headMap.get(key)) changed.push({ file, key });
    }
  }

  const breaking = breakOnRemovedKeys && removed.length > 0;
  if (added.length + removed.length + changed.length === 0) {
    return { markdown: '', breaking: false, checked: true, added, removed, changed };
  }

  const lines = ['| File | Key | Change |', '| --- | --- | --- |'];
  const row = (item, change) => {
    const key = item.key === '*' ? '_(entire file)_' : inlineCode(item.key);
    lines.push(`| ${inlineCode(item.file)} | ${key} | ${change} |`);
  };
  for (const item of added) row(item, 'added');
  for (const item of removed) row(item, 'removed');
  for (const item of changed) row(item, 'value changed');
  return {
    markdown: `${lines.join('\n')}\n`,
    breaking,
    checked: true,
    added,
    removed,
    changed,
  };
}
