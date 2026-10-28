#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * CLI: snapshot entry-point complexity for a checkout.
 *
 *   node scripts/entry-complexity/snapshot.mjs --root <dir> [--packs contrib/spring.json] [--out file.json]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { snapshotCheckout } from './engine.mjs';

function parseArgs(argv) {
  const map = {};
  const packs = [];
  const kinds = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--out' || a === '--profile') {
      map[a.slice(2)] = argv[++i];
    } else if (a === '--packs') {
      packs.push(argv[++i]);
    } else if (a === '--kinds') {
      kinds.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  return {
    root: map.root,
    out: map.out,
    profile: map.profile ?? 'vertique',
    packs,
    kinds: kinds.length ? kinds : undefined,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.root) throw new Error('missing --root');
  const actionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const snap = snapshotCheckout(args.root, {
    profile: args.profile,
    packs: args.packs,
    kinds: args.kinds,
    actionRoot,
  });
  const json = `${JSON.stringify(snap, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, json);
  else process.stdout.write(json);
  console.error(
    `entry-complexity: ${snap.entries.length} entries, engine=${snap.engine}`,
  );
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err?.message ?? err);
  process.exit(1);
}
