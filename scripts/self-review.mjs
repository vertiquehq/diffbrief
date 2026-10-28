// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [base, head] = process.argv.slice(2);
const raw = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, head], {
  cwd: process.env.DIFFBRIEF_HEAD, encoding: 'utf8',
});
const files = raw.split('\0').filter(Boolean);
const groups = [
  ['Action contract', (f) => f === 'action.yml'],
  ['Producers and runtime', (f) => f.startsWith('scripts/')],
  ['Tests and fixtures', (f) => f.startsWith('tests/') || f.startsWith('fixtures/')],
  ['Documentation and examples', (f) => /^(README\.md|BACKLOG\.md|docs\/|examples\/)/.test(f)],
  ['CI and configuration', (f) => f.startsWith('.github/') || f === 'package.json'],
];
const lines = groups.map(([label, match]) => [label, files.filter(match).length])
  .filter(([, count]) => count > 0).map(([label, count]) => `- ${label}: ${count} file${count === 1 ? '' : 's'}`);
if (lines.length) writeFileSync(path.join(process.env.DIFFBRIEF_FRAGMENT_DIR, 'fragment.md'), `${lines.join('\n')}\n`);
