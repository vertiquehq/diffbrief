// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Emit GitHub Actions outputs for configured producers.
 * Long values (build commands, spec lists) are written next to the config
 * under the runner temp directory so multiline env stays safe.
 *
 *   node scripts/prepare-openapi.mjs --config <file> --state-dir <dir> >> "$GITHUB_OUTPUT"
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

function main(argv, env = process.env) {
  const configPath =
    option(argv, 'config', 'DIFFBRIEF_CONFIG', env) ||
    path.resolve(env.GITHUB_WORKSPACE || process.cwd(), '.github/diffbrief.json');
  const stateDir =
    option(argv, 'state-dir', 'DIFFBRIEF_STATE_DIR', env) ||
    path.join(env.RUNNER_TEMP || '/tmp', 'diffbrief-state');
  mkdirSync(stateDir, { recursive: true });

  const config = loadConfig(path.resolve(configPath));
  const enabled = hasProducer(config, 'openapi');
  const producer = producerOfType(config, 'openapi');
  const buildFile = path.join(stateDir, 'build-command.sh');
  const specsFile = path.join(stateDir, 'specs-list.txt');
  writeFileSync(buildFile, producer?.buildCommand ? `${producer.buildCommand}\n` : '');
  writeFileSync(specsFile, producer?.specs?.length ? `${producer.specs.join('\n')}\n` : '');

  const lines = [
    `openapi=${enabled ? 'true' : 'false'}`,
    `maven-reactor=${hasProducer(config, 'maven-reactor') ? 'true' : 'false'}`,
    `state-dir=${stateDir}`,
    `build-command-file=${buildFile}`,
    `specs-list-file=${specsFile}`,
  ];
  if (producer) {
    lines.push(`oasdiff-version=${producer.oasdiffVersion}`);
    lines.push(`oasdiff-sha256=${producer.oasdiffSha256}`);
    lines.push(`discover=${producer.discover ?? ''}`);
    lines.push(`specs-glob=${producer.specsGlob}`);
    lines.push(`skip-build=${producer.skipBuild ? 'true' : 'false'}`);
  }
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
