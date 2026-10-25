// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Load and normalize a consumer's diffbrief.json.
 *
 * The file is optional. Built-in defaults cover a Maven reactor that
 * generates OpenAPI documents. Any repository can override relevant path
 * globs, which producers to run, how OpenAPI specs are built and found,
 * the sticky-comment marker, and whether the job fails on breaking changes.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MARKER = '<!-- diffbrief -->';
export const DEFAULT_TITLE = 'Pull request review';
export const DEFAULT_ARTIFACT = 'diffbrief';
export const DEFAULT_NODE_CAP = 60;
export const DEFAULT_OASDIFF_VERSION = '1.34.1';
export const DEFAULT_OASDIFF_SHA256 =
  '75775f65b0adebd26a8e013af51a799342dfdc6262d89efa9e3b7bdf89657d90';

export const DEFAULT_RELEVANT = ['**/pom.xml', '**/src/main/**', '.github/diffbrief.json'];

export const DEFAULT_PRODUCERS = [
  { type: 'maven-reactor' },
  {
    type: 'openapi',
    discover: 'swagger-outputFileName',
    specsGlob: '**/target/classes/openapi.yaml',
    oasdiffVersion: DEFAULT_OASDIFF_VERSION,
    oasdiffSha256: DEFAULT_OASDIFF_SHA256,
  },
];

/** Convert a limited glob (`*`, `**`, `?`) to a RegExp anchored to the whole path. */
export function globToRegExp(pattern) {
  const src = String(pattern).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '*') {
      if (src[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (src[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if ('\\.[]{}()+-^$|'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  out += '$';
  return new RegExp(out);
}

export function matchGlob(pattern, file) {
  const norm = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  return globToRegExp(pattern).test(norm);
}

export function matchAnyGlob(patterns, file) {
  return patterns.some((pattern) => matchGlob(pattern, file));
}

function asArray(value, fallback) {
  if (value == null) return fallback;
  if (!Array.isArray(value)) throw new Error('config value must be an array');
  return value;
}

const KNOWN_TYPES = new Set([
  'maven-reactor',
  'openapi',
  'asyncapi',
  'migrations',
  'i18n',
  'dependencies',
  'sarif',
  'playwright',
  'command',
]);

/** Globs each producer implies so relevance stays useful when the consumer enables it. */
export function impliedRelevant(producer) {
  switch (producer.type) {
    case 'migrations':
      return producer.globs?.length
        ? producer.globs
        : ['**/db/migration/**', '**/db/migrations/**', '**/flyway/**', '**/liquibase/**'];
    case 'i18n':
      return producer.globs?.length
        ? producer.globs
        : ['**/messages*.properties', '**/i18n/**', '**/locales/**', '**/lang/**'];
    case 'asyncapi':
      return producer.globs?.length
        ? producer.globs
        : ['**/asyncapi.yaml', '**/asyncapi.yml', '**/asyncapi.json'];
    case 'dependencies':
      return [
        '**/pom.xml',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/pnpm-lock.yaml',
        '**/Cargo.lock',
        ...(producer.lockfiles ?? []),
      ];
    case 'sarif':
      return [producer.baseSarif, producer.headSarif].filter(Boolean);
    case 'playwright':
      return producer.resultsDirs?.length
        ? producer.resultsDirs.map((d) => `${d}/**`)
        : ['**/test-results/**', '**/playwright-report/**'];
    case 'openapi':
      return ['**/pom.xml', '**/src/main/**'];
    case 'maven-reactor':
      return ['**/pom.xml'];
    default:
      return [];
  }
}

function normalizeProducer(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`producers[${index}] must be an object`);
  const type = raw.type;
  if (!KNOWN_TYPES.has(type)) {
    throw new Error(
      `producers[${index}].type must be one of ${[...KNOWN_TYPES].sort().join(', ')}`,
    );
  }
  if (type === 'maven-reactor') return { type: 'maven-reactor' };
  if (type === 'openapi') {
    return {
      type: 'openapi',
      discover: raw.discover ?? null,
      buildCommand: raw.buildCommand ?? null,
      specsGlob: raw.specsGlob ?? '**/target/classes/openapi.yaml',
      specs: Array.isArray(raw.specs) ? raw.specs.map(String) : null,
      oasdiffVersion: raw.oasdiffVersion ?? DEFAULT_OASDIFF_VERSION,
      oasdiffSha256: raw.oasdiffSha256 ?? DEFAULT_OASDIFF_SHA256,
      skipBuild: raw.skipBuild === true,
      cacheSpecs: raw.cacheSpecs === true,
    };
  }
  if (type === 'asyncapi') {
    return {
      type: 'asyncapi',
      globs: Array.isArray(raw.globs) ? raw.globs.map(String) : null,
      specs: Array.isArray(raw.specs) ? raw.specs.map(String) : null,
    };
  }
  if (type === 'migrations') {
    return {
      type: 'migrations',
      globs: Array.isArray(raw.globs) ? raw.globs.map(String) : null,
      breakOnEditedVersioned: raw.breakOnEditedVersioned !== false,
    };
  }
  if (type === 'i18n') {
    return {
      type: 'i18n',
      globs: Array.isArray(raw.globs) ? raw.globs.map(String) : null,
      breakOnRemovedKeys: raw.breakOnRemovedKeys !== false,
    };
  }
  if (type === 'dependencies') {
    return {
      type: 'dependencies',
      // null → auto-detect which lockfiles exist on either side
      lockfiles: Array.isArray(raw.lockfiles) ? raw.lockfiles.map(String) : null,
    };
  }
  if (type === 'sarif') {
    return {
      type: 'sarif',
      baseSarif: String(raw.baseSarif ?? 'diffbrief-out/base.sarif'),
      headSarif: String(raw.headSarif ?? 'diffbrief-out/head.sarif'),
      breakOnLevels: Array.isArray(raw.breakOnLevels)
        ? raw.breakOnLevels.map(String)
        : ['error', 'critical'],
    };
  }
  if (type === 'playwright') {
    return {
      type: 'playwright',
      resultsDirs: Array.isArray(raw.resultsDirs) ? raw.resultsDirs.map(String) : null,
      videoGlobs: Array.isArray(raw.videoGlobs) ? raw.videoGlobs.map(String) : null,
      traceGlobs: Array.isArray(raw.traceGlobs) ? raw.traceGlobs.map(String) : null,
      maxVideos: raw.maxVideos == null ? 10 : Number(raw.maxVideos),
      maxTraces: raw.maxTraces == null ? 10 : Number(raw.maxTraces),
      pathFilter: Array.isArray(raw.pathFilter) ? raw.pathFilter.map(String) : null,
    };
  }
  if (type === 'command') {
    if (!raw.run) throw new Error(`producers[${index}].run is required for type command`);
    return {
      type: 'command',
      id: String(raw.id ?? `command-${index}`),
      run: String(raw.run),
      shell: raw.shell === true,
    };
  }
  throw new Error(`producers[${index}].type is not implemented: ${type}`);
}

export function normalizeConfig(raw = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('diffbrief config must be a JSON object');
  }
  const failOn = raw.failOn ?? 'breaking';
  if (failOn !== 'breaking' && failOn !== 'never') {
    throw new Error('failOn must be "breaking" or "never"');
  }
  const producers = asArray(raw.producers, DEFAULT_PRODUCERS).map(normalizeProducer);
  const nodeCap = raw.nodeCap == null ? DEFAULT_NODE_CAP : Number(raw.nodeCap);
  if (!Number.isInteger(nodeCap) || nodeCap < 1) throw new Error('nodeCap must be a positive integer');
  const relevantExplicit = raw.relevant != null;
  const relevant = asArray(raw.relevant, DEFAULT_RELEVANT).map(String);
  if (!relevantExplicit) {
    for (const producer of producers) {
      for (const glob of impliedRelevant(producer)) {
        if (glob && !relevant.includes(glob)) relevant.push(glob);
      }
    }
  }
  return {
    marker: String(raw.marker ?? DEFAULT_MARKER),
    title: String(raw.title ?? DEFAULT_TITLE),
    artifact: String(raw.artifact ?? DEFAULT_ARTIFACT),
    nodeCap,
    failOn,
    relevant,
    producers,
  };
}

export function loadConfig(file, { required = false } = {}) {
  if (!file) return normalizeConfig({});
  if (!existsSync(file)) {
    if (required) throw new Error(`diffbrief config not found: ${file}`);
    return normalizeConfig({});
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`diffbrief config is not valid JSON (${file}): ${err.message}`);
  }
  return normalizeConfig(parsed);
}

export function producerOfType(config, type) {
  return config.producers.find((producer) => producer.type === type) ?? null;
}

export function hasProducer(config, type) {
  return config.producers.some((producer) => producer.type === type);
}

function option(argv, name, envName, env) {
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    return value;
  }
  if (env[envName]) return env[envName];
  return null;
}

function main(argv, env = process.env) {
  const file = option(argv, 'config', 'DIFFBRIEF_CONFIG', env) ?? '.github/diffbrief.json';
  const required = argv.includes('--required') || env.DIFFBRIEF_CONFIG_REQUIRED === '1';
  const config = loadConfig(path.resolve(file), { required });
  process.stdout.write(`${JSON.stringify(config)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
