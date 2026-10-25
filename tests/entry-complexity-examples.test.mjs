// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Optional live check against Vertique example trees when present locally.
 * Skips cleanly in CI clones that only contain this action repository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { snapshotCheckout } = await import(
  pathToFileURL(path.join(ROOT, 'scripts/entry-complexity/engine.mjs')).href
);

const CANDIDATES = [
  path.resolve(ROOT, '../vertique-dev/sources/vertique/examples'),
  path.resolve(ROOT, '../../vertique-dev/sources/vertique/examples'),
  '/Users/mika/Development/VertiqueHQ/vertique-dev/sources/vertique/examples',
];
const ENT_CANDIDATES = CANDIDATES.map((p) => p.replace(/\/vertique\/examples$/, '/vertique-enterprise/examples'));

function firstExisting(paths) {
  return paths.find((p) => existsSync(p)) ?? null;
}

const EXAMPLES = firstExisting(CANDIDATES);
const ENT = firstExisting(ENT_CANDIDATES);

describe('entry-complexity against Vertique examples', { skip: !EXAMPLES }, () => {
  it('finds JAX-RS entries in hello and follows services across the bus proxy', () => {
    const hello = snapshotCheckout(path.join(EXAMPLES, 'vertique-example-hello'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    assert.ok(hello.entries.filter((e) => e.kind === 'http').length >= 10);

    const services = snapshotCheckout(path.join(EXAMPLES, 'vertique-example-services'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    const getUser = services.entries.find((e) => e.id === 'http:GET:/users/{id}');
    assert.ok(getUser);
    assert.ok(getUser.methods >= 2, 'expected typed UserService call to reach implementations');

    const mcp = snapshotCheckout(path.join(EXAMPLES, 'vertique-example-mcp'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    assert.ok(mcp.entries.some((e) => e.id === 'mcp:weather.current'));

    const restClient = snapshotCheckout(path.join(EXAMPLES, 'vertique-example-rest-client'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    assert.equal(
      restClient.entries.filter((e) => String(e.path).includes('/api/users')).length,
      0,
      '@RestClient interfaces must not become http entries',
    );
  });
});

describe('entry-complexity against Vertique enterprise examples', { skip: !ENT }, () => {
  it('finds blob REST and MCP tools with constant-resolved names', () => {
    const blob = snapshotCheckout(path.join(ENT, 'vertique-example-blob'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    assert.ok(blob.entries.some((e) => e.kind === 'http'));

    const mcp = snapshotCheckout(path.join(ENT, 'vertique-example-mcp'), {
      profile: 'vertique',
      actionRoot: ROOT,
    });
    assert.ok(mcp.entries.some((e) => e.id === 'mcp:weather.current'));
  });
});
