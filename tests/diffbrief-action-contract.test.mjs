// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Composite action contract and configurable path classification.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const ACTION = path.join(REPO_ROOT, 'action.yml');
const { changedPaths, classifyPaths, isRelevantPath, mergeBase } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'scripts', 'classify.mjs')).href,
);
const { globToRegExp, loadConfig, matchGlob, normalizeConfig } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'scripts', 'config.mjs')).href,
);

describe('path classification', () => {
  it('uses Maven-oriented defaults', () => {
    assert.equal(isRelevantPath('pom.xml'), true);
    assert.equal(isRelevantPath('vertique-core/pom.xml'), true);
    assert.equal(isRelevantPath('vertique-core/src/main/java/A.java'), true);
    assert.equal(isRelevantPath('src/main/resources/openapi.yaml'), true);
    assert.equal(isRelevantPath('.github/diffbrief.json'), true);
    assert.equal(isRelevantPath('scripts/run.mjs'), false);
    assert.equal(isRelevantPath('vertique-core/src/test/java/A.java'), false);
    assert.equal(isRelevantPath('README.md'), false);
    assert.equal(isRelevantPath('.github/workflows/diffbrief.yml'), false);
    assert.equal(classifyPaths(['README.md', 'vertique-core/pom.xml']), true);
    assert.equal(classifyPaths(['README.md']), false);
    assert.equal(classifyPaths([]), false);
  });

  it('honors custom relevant globs', () => {
    const patterns = ['openapi/**', 'api/*.yaml'];
    assert.equal(isRelevantPath('openapi/v1.yaml', patterns), true);
    assert.equal(isRelevantPath('api/public.yaml', patterns), true);
    assert.equal(isRelevantPath('pom.xml', patterns), false);
  });

  it('classifies a three-dot diff', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-classify-'));
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.email', 'test@invalid']);
    git(['config', 'user.name', 'test']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(path.join(dir, 'README.md'), 'a\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']).toString().trim();
    mkdirSync(path.join(dir, 'src', 'main'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'main', 'A.java'), 'class A {}\n');
    git(['add', 'src/main/A.java']);
    git(['commit', '-q', '-m', 'head']);
    const head = git(['rev-parse', 'HEAD']).toString().trim();
    const script = path.join(REPO_ROOT, 'scripts', 'classify.mjs');
    const relevant = execFileSync('node', [script, '--base', base, '--head', head], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: dir, DIFFBRIEF_CONFIG: '' } });
    assert.equal(relevant.trim(), 'relevant=true');
    rmSync(dir, { recursive: true, force: true });
  });

  it('checks out the merge base when the base branch advanced', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'diffbrief-merge-base-'));
    const baseDir = mkdtempSync(path.join(tmpdir(), 'diffbrief-merge-base-wt-'));
    rmSync(baseDir, { recursive: true, force: true });
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.email', 'test@invalid']);
    git(['config', 'user.name', 'test']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(path.join(dir, 'README.md'), 'root\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'root']);
    git(['checkout', '-q', '-b', 'feature']);
    writeFileSync(path.join(dir, 'README.md'), 'feature\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'feature']);
    const head = git(['rev-parse', 'HEAD']).toString().trim();
    git(['checkout', '-q', 'main']);
    mkdirSync(path.join(dir, 'src', 'main'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'main', 'Later.java'), 'class Later {}\n');
    git(['add', 'src/main/Later.java']);
    git(['commit', '-q', '-m', 'later on main']);
    const baseTip = git(['rev-parse', 'HEAD']).toString().trim();
    assert.notEqual(mergeBase(baseTip, head, dir), baseTip);
    assert.deepEqual(changedPaths(baseTip, head, dir), ['README.md']);
    execFileSync('bash', [path.join(REPO_ROOT, 'scripts', 'checkout-base.sh')], {
      cwd: dir,
      env: { ...process.env, BASE_SHA: baseTip, HEAD_SHA: head, BASE_DIR: baseDir },
      stdio: 'pipe',
    });
    assert.equal(readFileSync(path.join(baseDir, 'README.md'), 'utf8'), 'root\n');
    assert.equal(existsSync(path.join(baseDir, 'src', 'main', 'Later.java')), false);
    execFileSync('git', ['worktree', 'remove', '--force', baseDir], { cwd: dir, stdio: 'pipe' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('config', () => {
  it('normalizes defaults and custom producers', () => {
    const defaults = normalizeConfig({});
    assert.equal(defaults.marker, '<!-- diffbrief -->');
    assert.equal(defaults.failOn, 'breaking');
    assert.equal(defaults.producers.map((p) => p.type).join(','), 'maven-reactor,openapi');
    const custom = normalizeConfig({
      failOn: 'never',
      relevant: ['docs/**'],
      producers: [{ type: 'openapi', skipBuild: true, specs: ['openapi.yaml'] }],
    });
    assert.equal(custom.failOn, 'never');
    assert.deepEqual(custom.relevant, ['docs/**']);
    assert.equal(custom.producers.length, 1);
    assert.equal(custom.producers[0].skipBuild, true);
  });

  it('matches limited globs', () => {
    assert.equal(matchGlob('**/pom.xml', 'a/b/pom.xml'), true);
    assert.equal(matchGlob('**/src/main/**', 'mod/src/main/java/A.java'), true);
    assert.equal(matchGlob('api/*.yaml', 'api/public.yaml'), true);
    assert.equal(matchGlob('api/*.yaml', 'api/nested/public.yaml'), false);
    assert.ok(globToRegExp('a/**/b').test('a/x/y/b'));
  });

  it('loads a missing config as defaults', () => {
    const cfg = loadConfig(path.join(tmpdir(), 'no-such-diffbrief.json'));
    assert.equal(cfg.artifact, 'diffbrief');
  });
});

describe('action.yml', () => {
  const yaml = () => readFileSync(ACTION, 'utf8');

  it('is a composite action with a token input', () => {
    const text = yaml();
    assert.match(text, /using:\s*composite/);
    assert.match(text, /token:/);
    assert.match(text, /pull_request/);
    assert.doesNotMatch(text, /pull_request_target/);
    assert.doesNotMatch(text, /oasdiff-action/);
    assert.doesNotMatch(text, /review:\s*true/);
  });

  it('invokes scripts through github.action_path', () => {
    const text = yaml();
    assert.match(text, /github\.action_path.*scripts\/classify\.mjs/);
    assert.match(text, /github\.action_path.*scripts\/checkout-base\.sh/);
    assert.match(text, /github\.action_path.*scripts\/run\.mjs/);
    assert.match(text, /github\.action_path.*scripts\/check-breaking\.mjs/);
  });

  it('pins upload-artifact and cache actions by commit SHA', () => {
    assert.match(yaml(), /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.match(yaml(), /actions\/cache\/restore@[0-9a-f]{40}/);
    assert.match(yaml(), /actions\/cache\/save@[0-9a-f]{40}/);
  });
});
