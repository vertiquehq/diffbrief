// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests/fixtures/entry-complexity');

const { snapshotCheckout } = await import(
  pathToFileURL(path.join(ROOT, 'scripts/entry-complexity/engine.mjs')).href
);
const { diffEntryComplexity } = await import(
  pathToFileURL(path.join(ROOT, 'scripts/entry-complexity-diff.mjs')).href
);
const { normalizeConfig } = await import(pathToFileURL(path.join(ROOT, 'scripts/config.mjs')).href);

describe('entry-complexity engine', () => {
  it('detects JAX-RS, MCP, Kafka, and delayed-job entries', () => {
    const snap = snapshotCheckout(path.join(FIX, 'base'), { profile: 'vertique', actionRoot: ROOT });
    const kinds = new Set(snap.entries.map((e) => e.kind));
    assert.ok(kinds.has('http'));
    assert.ok(kinds.has('mcp'));
    assert.ok(kinds.has('listener'));
    assert.ok(kinds.has('job'));
    const http = snap.entries.find((e) => e.id === 'http:GET:/hello/{name}');
    assert.ok(http, `missing http entry, got ${snap.entries.map((e) => e.id).join(', ')}`);
    assert.equal(http.flowCc, 0);
    assert.ok(http.flow.some((f) => f.method.includes('Greeter#greet')));
    const mcp = snap.entries.find((e) => e.id === 'mcp:weather.current');
    assert.ok(mcp);
    const kafka = snap.entries.find((e) => e.kind === 'listener');
    assert.equal(kafka.path, 'orders.created');
    const job = snap.entries.find((e) => e.kind === 'job');
    assert.equal(job.path, 'send-welcome');
  });

  it('ignores Spring mappings without the spring pack', () => {
    const snap = snapshotCheckout(path.join(FIX, 'head'), { profile: 'vertique', actionRoot: ROOT });
    assert.equal(
      snap.entries.filter((e) => e.path === '/spring' || e.label === '/spring').length,
      0,
    );
    assert.ok(!snap.entries.some((e) => e.id.includes('spring')));
  });

  it('opts into Spring via contrib pack', () => {
    const snap = snapshotCheckout(path.join(FIX, 'head'), {
      profile: 'none',
      packs: ['contrib/spring.json'],
      actionRoot: ROOT,
    });
    assert.ok(snap.entries.some((e) => e.kind === 'http' && e.path.includes('spring')));
  });

  it('ranks the heavier greet flow in the delta', () => {
    const result = diffEntryComplexity(path.join(FIX, 'base'), path.join(FIX, 'head'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    assert.equal(result.breaking, false);
    const row = result.rows.find((r) => r.id === 'http:GET:/hello/{name}');
    assert.ok(row);
    assert.ok(row.after > row.before, `expected after>${row.before}, got ${row.after}`);
    assert.equal(row.status, 'touched');
    assert.match(result.markdown, /GET \/hello\/\{name\}/);
    assert.match(result.markdown, /\+/);
  });

  it('normalizes the producer in config', () => {
    const cfg = normalizeConfig({
      producers: [{ type: 'entry-complexity', packs: ['contrib/spring.json'] }],
    });
    const p = cfg.producers.find((x) => x.type === 'entry-complexity');
    assert.equal(p.profile, 'vertique');
    assert.deepEqual(p.packs, ['contrib/spring.json']);
    assert.ok(cfg.relevant.some((g) => g.includes('src/main/java')));
  });
});
