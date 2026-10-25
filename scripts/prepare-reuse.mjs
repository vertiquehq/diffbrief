// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Emit cache / reuse outputs for OpenAPI specs.
 *
 *   node scripts/prepare-reuse.mjs >> "$GITHUB_OUTPUT"
 *
 * Reads BASE_SHA + HEAD_SHA, prints merge-base and whether to skip builds
 * when head/base spec dirs are already populated (caller-supplied reuse).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasProducer, loadConfig, producerOfType } from './config.mjs';

function option(argv, name, envName, env) {
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    return value;
  }
  return env[envName] || null;
}

function hasSpecs(dir) {
  if (!dir || !existsSync(dir)) return false;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
      } else if (entry.name === 'openapi.yaml' || entry.name === 'openapi.yml') {
        return true;
      }
    }
    return false;
  };
  return walk(dir);
}

function main(argv, env = process.env) {
  const baseSha = option(argv, 'base', 'BASE_SHA', env);
  const headSha = option(argv, 'head', 'HEAD_SHA', env);
  if (!baseSha || !headSha) throw new Error('BASE_SHA and HEAD_SHA are required');
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const mergeBase = execFileSync('git', ['merge-base', baseSha, headSha], {
    cwd,
    encoding: 'utf8',
  }).trim();

  const configPath =
    option(argv, 'config', 'DIFFBRIEF_CONFIG', env) || path.resolve(cwd, '.github/diffbrief.json');
  const config = loadConfig(path.resolve(configPath));
  const openapi = producerOfType(config, 'openapi');
  const cacheFlag = String(env.DIFFBRIEF_CACHE_SPECS || '').toLowerCase();
  const cacheSpecs =
    openapi?.cacheSpecs === true || cacheFlag === '1' || cacheFlag === 'true';

  const out = option(argv, 'out', 'OUT_DIR', env) || path.join(cwd, 'diffbrief-out');
  const headSpecs =
    option(argv, 'head-specs', 'HEAD_SPECS', env) || path.join(out, 'head-specs');
  const baseSpecs =
    option(argv, 'base-specs', 'BASE_SPECS', env) || path.join(out, 'base-specs');
  const headReady = hasSpecs(headSpecs);
  const baseReady = hasSpecs(baseSpecs);
  const skipHeadBuild = headReady || openapi?.skipBuild === true;
  const skipBaseBuild = baseReady || openapi?.skipBuild === true;

  const lines = [
    `merge-base=${mergeBase}`,
    `cache-specs=${cacheSpecs && hasProducer(config, 'openapi') ? 'true' : 'false'}`,
    `head-specs-ready=${headReady ? 'true' : 'false'}`,
    `base-specs-ready=${baseReady ? 'true' : 'false'}`,
    `skip-head-build=${skipHeadBuild ? 'true' : 'false'}`,
    `skip-base-build=${skipBaseBuild ? 'true' : 'false'}`,
    `head-cache-key=diffbrief-openapi-${headSha}`,
    `base-cache-key=diffbrief-openapi-${mergeBase}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
