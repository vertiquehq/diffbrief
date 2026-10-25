// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff Flyway / Liquibase-style migration files between two checkouts.
 *
 * No database is started. Files are matched by glob (default covers common
 * Flyway layouts). A versioned migration whose bytes change is treated as a
 * breaking finding: rewriting applied history is unsafe. Repeatable (R__)
 * and Liquibase changelog edits are reported but not breaking by default.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { matchGlob } from './config.mjs';
import { cmp, inlineCode } from './util.mjs';

export const DEFAULT_MIGRATION_GLOBS = [
  '**/db/migration/**',
  '**/db/migrations/**',
  '**/flyway/**/*.sql',
  '**/liquibase/**/*.{sql,xml,yml,yaml}',
  '**/changelog*/**/*.{sql,xml,yml,yaml}',
];

const VERSIONED = /(^|\/)V[0-9][^/]*\.(sql|SQL)$/;

function walkFiles(root, globs, listDir) {
  const found = new Map();
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
      if (globs.some((g) => matchGlob(g, rel))) {
        const body = readFileSync(full);
        found.set(rel, {
          path: rel,
          sha256: createHash('sha256').update(body).digest('hex'),
          versioned: VERSIONED.test(rel),
        });
      }
    }
  };
  walk(root);
  return found;
}

/**
 * @returns {{ markdown: string, breaking: boolean, checked: boolean, added: string[], removed: string[], changed: string[] }}
 */
export function diffMigrations(baseRoot, headRoot, options = {}) {
  const globs = options.globs?.length ? options.globs : DEFAULT_MIGRATION_GLOBS;
  const listDir = options.listDir ?? readdirSync;
  const breakOnEditedVersioned = options.breakOnEditedVersioned !== false;
  const base = walkFiles(baseRoot, globs, listDir);
  const head = walkFiles(headRoot, globs, listDir);
  const keys = [...new Set([...base.keys(), ...head.keys()])].sort(cmp);
  const added = [];
  const removed = [];
  const changed = [];
  const editedVersioned = [];

  for (const key of keys) {
    const b = base.get(key);
    const h = head.get(key);
    if (b && !h) removed.push(key);
    else if (!b && h) added.push(key);
    else if (b && h && b.sha256 !== h.sha256) {
      changed.push(key);
      if (h.versioned || b.versioned) editedVersioned.push(key);
    }
  }

  const breaking = breakOnEditedVersioned && editedVersioned.length > 0;
  if (added.length + removed.length + changed.length === 0) {
    return { markdown: '', breaking: false, checked: true, added, removed, changed, editedVersioned };
  }

  const lines = ['| Migration | Change |', '| --- | --- |'];
  for (const p of added) lines.push(`| ${inlineCode(p)} | added |`);
  for (const p of removed) lines.push(`| ${inlineCode(p)} | removed |`);
  for (const p of changed) {
    const note = editedVersioned.includes(p) ? 'changed (versioned — unsafe if already applied)' : 'changed';
    lines.push(`| ${inlineCode(p)} | ${note} |`);
  }
  let markdown = `${lines.join('\n')}\n`;
  if (editedVersioned.length) {
    markdown += `\nVersioned migration files were edited: ${editedVersioned.map(inlineCode).join(', ')}. `
      + 'Flyway will not re-apply them; repair or a new version is required.\n';
  }
  return { markdown, breaking, checked: true, added, removed, changed, editedVersioned };
}
