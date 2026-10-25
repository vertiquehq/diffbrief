// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Decide whether a pull request needs the producer builds.
 *
 * A workflow path filter would skip the job after a later push removes the
 * last relevant file, and a stale comment would stay. This prints
 * `relevant=true` or `relevant=false` for the changed paths between the
 * merge base and the head. The merge base is `git merge-base` of the base
 * branch tip and the head. Relevance comes from the consumer's config
 * `relevant` globs (defaults cover Maven poms, src/main, and the config file).
 *
 *   node scripts/classify.mjs --base <sha> --head <sha> [--config <file>]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RELEVANT, loadConfig, matchAnyGlob } from './config.mjs';

export function isRelevantPath(file, patterns = DEFAULT_RELEVANT) {
  return matchAnyGlob(patterns, file);
}

export function classifyPaths(paths, patterns = DEFAULT_RELEVANT) {
  return paths.some((file) => isRelevantPath(file, patterns));
}

function option(argv, name, envName, env, { required = true } = {}) {
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    return value;
  }
  if (env[envName]) return env[envName];
  if (required) throw new Error(`missing --${name}`);
  return null;
}

export function mergeBase(base, head, cwd, exec = execFileSync) {
  const out = exec('git', ['merge-base', base, head], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return String(out).trim();
}

export function changedPaths(base, head, cwd, exec = execFileSync) {
  const baseCommit = mergeBase(base, head, cwd, exec);
  const out = exec('git', ['diff', '--name-only', '--no-renames', `${baseCommit}...${head}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return String(out).split('\n').map((line) => line.trim()).filter(Boolean);
}

function main(argv, env = process.env) {
  const base = option(argv, 'base', 'BASE_SHA', env);
  const head = option(argv, 'head', 'HEAD_SHA', env);
  const configPath = option(argv, 'config', 'DIFFBRIEF_CONFIG', env, { required: false });
  const config = loadConfig(configPath ? path.resolve(configPath) : path.resolve(env.GITHUB_WORKSPACE || process.cwd(), '.github/diffbrief.json'));
  const relevant = classifyPaths(changedPaths(base, head, env.CLASSIFY_CWD || process.cwd()), config.relevant);
  process.stdout.write(`relevant=${relevant ? 'true' : 'false'}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
