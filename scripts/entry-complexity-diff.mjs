// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff two entry-complexity snapshots and render ranked markdown bars.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { snapshotCheckout } from './entry-complexity/engine.mjs';
import { inlineCode } from './util.mjs';

export const ENTRY_COMPLEXITY_SECTION = 'Did entry-point flows get heavier?';

const KIND_TITLES = [
  ['http', 'REST (JAX-RS)'],
  ['mcp', 'MCP tools'],
  ['listener', 'Message listeners'],
  ['job', 'Jobs'],
];

function bar(before, after, maxBar, scaleMax) {
  const scale = Math.max(1, scaleMax);
  const beforeUnits = Math.round((Math.max(0, before) / scale) * maxBar);
  const afterUnits = Math.round((Math.max(0, after) / scale) * maxBar);
  const grey = Math.min(beforeUnits, afterUnits);
  const green = Math.max(0, afterUnits - beforeUnits);
  const ghost = Math.max(0, beforeUnits - afterUnits);
  return `${'█'.repeat(grey)}${'▓'.repeat(green)}${'░'.repeat(ghost)}`;
}

function labelFor(entry) {
  if (entry.kind === 'http') return `${entry.httpMethod} ${entry.path}`;
  if (entry.kind === 'mcp') return entry.path || entry.handler;
  if (entry.kind === 'listener') return `${entry.httpMethod} ${entry.path || entry.handler}`;
  if (entry.kind === 'job') return entry.path || entry.handler;
  return entry.path || entry.handler;
}

/**
 * @returns {{ markdown: string, breaking: false, checked: boolean, rows: object[], base: object, head: object }}
 */
export function diffEntryComplexity(baseRoot, headRoot, options = {}) {
  const maxBar = options.maxBar ?? 40;
  const maxUntouched = options.maxUntouched ?? 12;
  const snapOpts = {
    profile: options.profile ?? 'vertique',
    packs: options.packs ?? [],
    kinds: options.kinds ?? undefined,
    actionRoot: options.actionRoot,
    listDir: options.listDir,
  };

  const base =
    options.baseSnapshot ??
    snapshotCheckout(baseRoot, snapOpts);
  const head =
    options.headSnapshot ??
    snapshotCheckout(headRoot, snapOpts);

  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(path.join(options.outDir, 'entry-complexity-base.json'), `${JSON.stringify(base, null, 2)}\n`);
    writeFileSync(path.join(options.outDir, 'entry-complexity-head.json'), `${JSON.stringify(head, null, 2)}\n`);
  }

  const baseMap = new Map(base.entries.map((e) => [e.id, e]));
  const headMap = new Map(head.entries.map((e) => [e.id, e]));
  const ids = [...new Set([...baseMap.keys(), ...headMap.keys()])];

  const rows = ids.map((id) => {
    const b = baseMap.get(id);
    const h = headMap.get(id);
    const before = b?.flowCc ?? 0;
    const after = h?.flowCc ?? 0;
    let status = 'untouched';
    if (!b && h) status = 'new';
    else if (b && !h) status = 'gone';
    else if (before !== after) status = 'touched';
    return {
      id,
      status,
      before,
      after,
      delta: after - before,
      kind: (h ?? b).kind,
      label: labelFor(h ?? b),
      handler: (h ?? b).handler,
      entry: h ?? b,
    };
  });

  rows.sort((a, b) => b.after - a.after || b.delta - a.delta || a.label.localeCompare(b.label));

  const scaleMax = Math.max(1, ...rows.map((r) => Math.max(r.before, r.after)));
  const lines = [];
  let any = false;

  for (const [kind, title] of KIND_TITLES) {
    const group = rows.filter((r) => r.kind === kind);
    if (!group.length) continue;
    const touched = group.filter((r) => r.status !== 'untouched');
    const untouched = group.filter((r) => r.status === 'untouched');
    const showUntouched = untouched.slice(0, maxUntouched);
    const hidden = untouched.length - showUntouched.length;
    if (!touched.length && !showUntouched.length) continue;
    any = true;
    lines.push(`### ${title}`);
    lines.push('');
    for (const row of [...touched, ...showUntouched]) {
      const mark =
        row.status === 'gone'
          ? 'gone'
          : row.status === 'new'
            ? 'new'
            : row.delta > 0
              ? `+${row.delta}`
              : row.delta < 0
                ? `${row.delta}`
                : '=';
      const faded = row.status === 'untouched' || row.status === 'gone';
      const prefix = faded ? '_ ' : '';
      const suffix = faded ? '_' : '';
      const chart = bar(row.before, row.after, maxBar, scaleMax);
      lines.push(
        `${prefix}\`${chart}\` **${row.after}** ${inlineCode(row.label)} (${row.before}→${row.after}, ${mark})${suffix}`,
      );
    }
    if (hidden > 0) lines.push(`_…and ${hidden} unchanged._`);
    lines.push('');
  }

  if (!any) {
    return {
      markdown: '_Checked — no annotated entry points found (or no complexity delta)._',
      breaking: false,
      checked: true,
      rows,
      base,
      head,
    };
  }

  lines.push(
    '_Cognitive complexity summed over methods reachable via typed calls in source. Event-bus hops that appear as typed service-contract calls are followed to implementations; raw bus addresses are not._',
  );

  return {
    markdown: lines.join('\n').trim() + '\n',
    breaking: false,
    checked: true,
    rows,
    base,
    head,
  };
}
