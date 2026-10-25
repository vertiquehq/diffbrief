// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { diffMigrations } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'migrations-diff.mjs')).href);
const { diffI18n, parseProperties } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'i18n-diff.mjs')).href);
const { diffDependencies } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'dependencies-diff.mjs')).href);
const { diffSarif } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'sarif-diff.mjs')).href);
const { diffAsyncApi } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'asyncapi-diff.mjs')).href);
const { normalizeConfig } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'config.mjs')).href);

function write(root, rel, body) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe('migrations producer', () => {
  it('lists added migrations and flags edited versioned files as breaking', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-mig-'));
    write(dir, 'base/db/migration/V1__init.sql', 'create table a;\n');
    write(dir, 'head/db/migration/V1__init.sql', 'create table a;\nalter table a add b int;\n');
    write(dir, 'head/db/migration/V2__more.sql', 'create table b;\n');
    const result = diffMigrations(path.join(dir, 'base'), path.join(dir, 'head'));
    assert.equal(result.breaking, true);
    assert.deepEqual(result.added, ['db/migration/V2__more.sql']);
    assert.deepEqual(result.editedVersioned, ['db/migration/V1__init.sql']);
    assert.match(result.markdown, /V2__more/);
    assert.match(result.markdown, /unsafe if already applied/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('i18n producer', () => {
  it('parses properties and reports key deltas', () => {
    assert.deepEqual([...parseProperties('a=1\n#c\nb: two\n')], [['a', '1'], ['b', 'two']]);
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-i18n-'));
    write(dir, 'base/i18n/messages.properties', 'hello=Hello\nbye=Bye\n');
    write(dir, 'head/i18n/messages.properties', 'hello=Hi\nnew=New\n');
    const result = diffI18n(path.join(dir, 'base'), path.join(dir, 'head'));
    assert.equal(result.breaking, true);
    assert.equal(result.removed.some((r) => r.key === 'bye'), true);
    assert.equal(result.added.some((r) => r.key === 'new'), true);
    assert.equal(result.changed.some((r) => r.key === 'hello'), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('dependencies producer', () => {
  it('diffs package-lock top-level packages', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-deps-'));
    const lock = (lodash) => JSON.stringify({
      packages: {
        '': { name: 'app' },
        'node_modules/left-pad': { version: '1.0.0' },
        'node_modules/lodash': { version: lodash },
      },
    });
    write(dir, 'base/package-lock.json', lock('4.0.0'));
    write(dir, 'head/package-lock.json', lock('4.17.21'));
    write(dir, 'head/package-lock.json', JSON.stringify({
      packages: {
        '': { name: 'app' },
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/zod': { version: '3.0.0' },
      },
    }));
    const result = diffDependencies({
      baseRoot: path.join(dir, 'base'),
      headRoot: path.join(dir, 'head'),
    });
    assert.match(result.markdown, /lodash/);
    assert.match(result.markdown, /zod/);
    assert.match(result.markdown, /left-pad/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('sarif producer', () => {
  it('lists findings introduced on head', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-sarif-'));
    const sarif = (ruleId, level = 'error') => JSON.stringify({
      runs: [{
        results: [{
          ruleId,
          level,
          message: { text: `${ruleId} hit` },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'A.java' }, region: { startLine: 10 } } }],
        }],
      }],
    });
    write(dir, 'base.sarif', sarif('OldRule', 'warning'));
    write(dir, 'head.sarif', JSON.stringify({
      runs: [{
        results: [
          {
            ruleId: 'OldRule',
            level: 'warning',
            message: { text: 'OldRule hit' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'A.java' }, region: { startLine: 10 } } }],
          },
          {
            ruleId: 'NewRule',
            level: 'error',
            message: { text: 'NewRule hit' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'B.java' }, region: { startLine: 3 } } }],
          },
        ],
      }],
    }));
    const result = diffSarif({
      baseSarif: path.join(dir, 'base.sarif'),
      headSarif: path.join(dir, 'head.sarif'),
    });
    assert.equal(result.breaking, true);
    assert.equal(result.introduced.length, 1);
    assert.equal(result.introduced[0].ruleId, 'NewRule');
    assert.match(result.markdown, /NewRule/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('asyncapi producer', () => {
  it('reports new and removed documents without invoking the CLI', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-async-'));
    write(dir, 'head/asyncapi.yaml', 'asyncapi: 2.6.0\n');
    write(dir, 'base/old/asyncapi.yaml', 'asyncapi: 2.6.0\n');
    const result = diffAsyncApi({
      baseRoot: path.join(dir, 'base'),
      headRoot: path.join(dir, 'head'),
      execFile() {
        throw new Error('CLI should not run for add/remove-only');
      },
    });
    assert.match(result.markdown, /new AsyncAPI document/);
    assert.match(result.markdown, /removed AsyncAPI document/);
    assert.equal(result.breaking, true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('config producers', () => {
  it('accepts the new producer types and implies relevance globs', () => {
    const cfg = normalizeConfig({
      producers: [
        { type: 'migrations' },
        { type: 'i18n' },
        { type: 'dependencies' },
        { type: 'asyncapi' },
        { type: 'sarif', baseSarif: 'base.sarif', headSarif: 'head.sarif' },
      ],
    });
    assert.equal(cfg.producers.length, 5);
    assert.ok(cfg.relevant.some((g) => g.includes('db/migration')));
    assert.ok(cfg.relevant.some((g) => g.includes('messages')));
    assert.ok(cfg.relevant.includes('**/package-lock.json'));
  });
});
