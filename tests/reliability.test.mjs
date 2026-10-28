// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffI18n } from '../scripts/i18n-diff.mjs';
import { diffMigrations } from '../scripts/migrations-diff.mjs';
import { diffAsyncApi } from '../scripts/asyncapi-diff.mjs';
import { diffOpenApi } from '../scripts/openapi-diff.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root, file, body) {
  const dest = path.join(root, file);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, body);
}
function failed() { const e = new Error('bad input'); e.status = 2; e.stderr = 'invalid spec'; throw e; }

test('default globs discover locale JSON and Liquibase files', (t) => {
  const dir = fixture(t);
  for (const side of ['base', 'head']) {
    write(dir, `${side}/locales/en.json`, side === 'base' ? '{"old":"x"}' : '{}');
    write(dir, `${side}/liquibase/V1__init.sql`, side);
  }
  assert.equal(diffI18n(path.join(dir, 'base'), path.join(dir, 'head')).breaking, true);
  assert.equal(diffMigrations(path.join(dir, 'base'), path.join(dir, 'head')).breaking, true);
});

test('API diff errors cannot look like unchanged specs', (t) => {
  const dir = fixture(t);
  for (const side of ['base', 'head']) {
    write(dir, `${side}/asyncapi.yaml`, 'asyncapi: 2.0.0');
    write(dir, `${side}/svc/openapi.yml`, 'openapi: 3.0.0');
  }
  const base = path.join(dir, 'base'); const head = path.join(dir, 'head');
  assert.throws(() => diffAsyncApi({ baseRoot: base, headRoot: head, execFile: failed }), /asyncapi failed.*invalid spec/);
  assert.throws(() => diffAsyncApi({ baseRoot: base, headRoot: head, execFile: () => 'not json' }), /invalid asyncapi breaking JSON/);
  assert.throws(() => diffOpenApi({ baseDir: base, headDir: head, execFile: failed }), /oasdiff failed.*invalid spec/);
  const result = diffOpenApi({ baseDir: base, headDir: head, execFile: (_bin, args) => args.includes('json') ? '[]' : '' });
  assert.equal(result.runs.length, 1);
});

test('reused artifacts must match the expected commit across pages', () => {
  const data = [{ artifacts: [{ id: 1, name: 'specs', workflow_run: { head_sha: 'wrong' } }] },
    { artifacts: [{ id: 2, name: 'specs', workflow_run: { head_sha: 'right' } }] }];
  const run = (sha) => spawnSync(process.execPath, ['scripts/pick-artifact.mjs'], {
    input: JSON.stringify(data), encoding: 'utf8', env: { ...process.env, ARTIFACT_NAME: 'specs', EXPECTED_SHA: sha },
  });
  assert.equal(run('right').stdout, '2');
  assert.notEqual(run('absent').status, 0);
});

test('project PR producer summarizes a real commit diff', (t) => {
  const dir = fixture(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  write(dir, 'scripts/producer.mjs', 'before');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  write(dir, 'scripts/producer.mjs', 'after');
  write(dir, 'tests/example.test.mjs', 'test');
  git('add', '.'); git('commit', '-qm', 'head');
  const baseDir = path.join(dir, 'base-worktree');
  git('worktree', 'add', '--detach', baseDir, base);
  const out = path.join(dir, 'out');
  const script = path.resolve('scripts/self-review.sh');
  mkdirSync(out, { recursive: true });
  const result = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env,
    DIFFBRIEF_BASE: baseDir, DIFFBRIEF_HEAD: dir, DIFFBRIEF_FRAGMENT_DIR: out } });
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(path.join(out, 'fragment.md'), 'utf8');
  assert.match(report, /Producers and runtime: 1 file/);
  assert.match(report, /Tests and fixtures: 1 file/);
});

test('command producer titles do not become artifact paths', async (t) => {
  const { run } = await import('../scripts/run.mjs');
  const { normalizeConfig } = await import('../scripts/config.mjs');
  const dir = fixture(t);
  const head = path.join(dir, 'head');
  mkdirSync(head);
  write(head, 'producer.sh', 'printf "hello\\n" > "$DIFFBRIEF_FRAGMENT_DIR/fragment.md"\n');
  const out = path.join(dir, 'out');
  const result = run({ base: head, head, out, config: normalizeConfig({
    producers: [{ type: 'command', id: 'What changed?', run: 'producer.sh' }],
  }) });
  assert.match(result.report, /What changed\?/);
  assert.equal(readFileSync(path.join(out, 'fragments', '0', 'fragment.md'), 'utf8'), 'hello\n');
});
