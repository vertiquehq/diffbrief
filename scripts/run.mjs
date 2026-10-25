// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * diffbrief entry point.
 *
 * Compares two checkouts using the producers listed in the consumer config,
 * writes the report and comment body, reconciles the sticky comment, and
 * records whether any producer reported a breaking change. This process
 * exits 0 even when breaking changes exist; check-breaking.mjs reads
 * `breaking` afterward when failOn is "breaking".
 *
 *   node scripts/run.mjs \
 *     --base <dir> --head <dir> --out <dir> \
 *     --pr <n> --repo <owner/name> [--config <file>] [--dry-run]
 */

import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dryRunClient, readEvent, reconcile } from './comment.mjs';
import { hasProducer, loadConfig, producerOfType } from './config.mjs';
import { extractReactor } from './maven-graph.mjs';
import { diffModules } from './module-diff.mjs';
import { apiVerdict, diffOpenApi } from './openapi-diff.mjs';
import {
  BASE_BUILD_FAILED,
  buildComment,
  renderOpenApiMarkdown,
  renderReport,
  renderVerdictBand,
  summaryText,
} from './report.mjs';
import { stableStringify } from './util.mjs';

const FLAGS = new Set(['dry-run', 'base-build-failed']);
const VALUED = new Set([
  'base',
  'head',
  'base-specs',
  'head-specs',
  'out',
  'pr',
  'repo',
  'node-cap',
  'relevant',
  'config',
]);

export function parseRunArgs(argv, env = process.env) {
  const map = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUED.has(name)) throw new Error(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    map[name] = value;
    i += 1;
  }
  return {
    base: map.base ?? env.BASE_DIR,
    head: map.head ?? env.HEAD_DIR,
    baseSpecs: map['base-specs'] ?? env.BASE_SPECS,
    headSpecs: map['head-specs'] ?? env.HEAD_SPECS,
    out: map.out ?? env.OUT_DIR,
    pr: map.pr ?? env.PR_NUMBER,
    repo: map.repo ?? env.REPO,
    nodeCap: map['node-cap'] ?? env.DIFFBRIEF_NODE_CAP,
    relevant: map.relevant ?? env.RELEVANT,
    configPath: map.config ?? env.DIFFBRIEF_CONFIG,
    dryRun: flags.has('dry-run') || env.DRY_RUN === '1',
    baseBuildFailed: flags.has('base-build-failed') || env.BASE_BUILD_OUTCOME === 'failure',
  };
}

function relevantRequested(value) {
  if (value == null || value === '') return true;
  return value !== false && value !== 'false';
}

function safeSpecName(specPath) {
  return specPath.replace(/[^A-Za-z0-9._-]+/g, '__');
}

export function tryWriteSvg(dotPath, svgPath, exec = execFileSync) {
  try {
    exec('dot', ['-Tsvg', '-o', svgPath, dotPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function resolveConfig(options) {
  if (options.config) return options.config;
  const file = options.configPath
    ? path.resolve(options.configPath)
    : path.resolve(options.head || process.cwd(), '.github/diffbrief.json');
  return loadConfig(file);
}

function runCommandProducer(producer, options) {
  const fragmentDir = path.join(options.out, 'fragments', producer.id);
  mkdirSync(fragmentDir, { recursive: true });
  const env = {
    ...process.env,
    DIFFBRIEF_BASE: options.base,
    DIFFBRIEF_HEAD: options.head,
    DIFFBRIEF_FRAGMENT_DIR: fragmentDir,
    DIFFBRIEF_OUT: options.out,
  };
  const cwd = options.head;
  if (producer.shell) {
    execSync(producer.run, { cwd, env, stdio: 'inherit' });
  } else {
    execFileSync('bash', [path.resolve(cwd, producer.run)], { cwd, env, stdio: 'inherit' });
  }
  const markdownPath = path.join(fragmentDir, 'fragment.md');
  const breakingPath = path.join(fragmentDir, 'breaking');
  const markdown = existsSync(markdownPath) ? readFileSync(markdownPath, 'utf8') : '';
  const breaking = existsSync(breakingPath) && readFileSync(breakingPath, 'utf8').trim() === 'true';
  return { id: producer.id, markdown, breaking };
}

/**
 * @param {object} options parsed arguments plus test overrides:
 *   client, event, execFile, summaryFile, outputFile, listDir, config, bin
 */
export function run(options) {
  const out = options.out;
  if (!out) throw new Error('missing --out');
  mkdirSync(out, { recursive: true });
  const config = resolveConfig(options);
  const relevant = relevantRequested(options.relevant);
  const nodeCap = options.nodeCap ?? config.nodeCap;
  let report = '';
  let breaking = false;
  let moduleDiff = null;
  let openApi = null;
  const extraSections = [];

  if (relevant) {
    if (!options.base || !options.head) throw new Error('missing --base or --head');

    if (hasProducer(config, 'maven-reactor')) {
      const baseModel = extractReactor(options.base, { listDir: options.listDir });
      const headModel = extractReactor(options.head, { listDir: options.listDir });
      writeText(path.join(out, 'module-graph-base.json'), stableStringify(baseModel));
      writeText(path.join(out, 'module-graph-head.json'), stableStringify(headModel));
      moduleDiff = diffModules(baseModel, headModel, { nodeCap });
      if (moduleDiff.dot) writeText(path.join(out, 'module-graph.dot'), moduleDiff.dot);
      else rmSync(path.join(out, 'module-graph.dot'), { force: true });
      if (!moduleDiff.dot) rmSync(path.join(out, 'module-graph.svg'), { force: true });
    }

    const openapiProducer = producerOfType(config, 'openapi');
    if (openapiProducer) {
      if (options.baseBuildFailed) {
        openApi = {
          breaking: false,
          sections: [],
          runs: [],
          verdict: apiVerdict(null, { baseBuildFailed: true }),
        };
      } else {
        if (!options.baseSpecs || !options.headSpecs) {
          throw new Error('openapi producer requires --base-specs and --head-specs');
        }
        openApi = diffOpenApi({
          baseDir: options.baseSpecs,
          headDir: options.headSpecs,
          bin: options.bin,
          execFile: options.execFile,
          listDir: options.listDir,
        });
        breaking = breaking || openApi.breaking;
        const oasDir = path.join(out, 'oasdiff');
        for (const entry of openApi.runs) {
          if (entry.kind !== 'changed' && entry.kind !== 'unchanged') continue;
          const name = safeSpecName(entry.path);
          const changelog =
            entry.changelog.endsWith('\n') || entry.changelog === '' ? entry.changelog : `${entry.changelog}\n`;
          writeText(path.join(oasDir, `${name}.changelog.md`), changelog === '' ? '\n' : changelog);
          writeText(path.join(oasDir, `${name}.breaking.txt`), `exit: ${entry.breakingStatus}\n${entry.breakingText}`);
          if (entry.changes) {
            writeText(path.join(oasDir, `${name}.changelog.json`), `${stableStringify(entry.changes)}\n`);
          }
        }
      }
      writeText(
        path.join(out, 'openapi-diff.json'),
        stableStringify({
          breaking: openApi.breaking,
          verdict: openApi.verdict,
          entries: openApi.runs.map(({ path: specPath, kind, changelogStatus, breakingStatus, summary }) => ({
            breakingStatus,
            changelogStatus,
            kind,
            path: specPath,
            summary: summary ?? null,
          })),
          ...(options.baseBuildFailed ? { note: BASE_BUILD_FAILED } : {}),
        }),
      );
      if (openApi.verdict) {
        writeText(path.join(out, 'openapi-verdict.md'), `${renderVerdictBand(openApi.verdict)}\n`);
      }
    }

    for (const producer of config.producers.filter((item) => item.type === 'command')) {
      const result = runCommandProducer(producer, options);
      if (result.markdown.trim()) {
        extraSections.push(`## ${result.id}\n\n${result.markdown.trim()}\n`);
      }
      breaking = breaking || result.breaking;
    }

    const openApiChecked = Boolean(openApi);
    const moduleChecked = Boolean(moduleDiff);
    const openApiMarkdown = openApi
      ? renderOpenApiMarkdown(openApi, { baseBuildFailed: options.baseBuildFailed })
      : '';
    const moduleMarkdown = moduleDiff?.markdown ?? '';
    report = renderReport({
      openApiMarkdown,
      moduleMarkdown,
      verdict: openApi?.verdict ?? null,
      openApiChecked,
      moduleChecked,
    });
    if (extraSections.length) {
      report = [report.trimEnd(), ...extraSections].filter(Boolean).join('\n\n') + '\n';
    }
    // A report that is only "checked — unchanged" stamps stays silent for the sticky comment.
    if (
      !moduleMarkdown.trim()
      && !openApiMarkdown.trim()
      && !extraSections.length
      && !options.baseBuildFailed
      && !(openApi?.verdict && openApi.verdict.kind !== 'no_changes' && openApi.verdict.kind !== 'not_run')
    ) {
      report = '';
    }
  }

  const comment = buildComment(report, {
    marker: config.marker,
    title: config.title,
    artifact: config.artifact,
  });
  writeText(path.join(out, 'report.md'), report.trim() ? report : 'No module graph or API changes\n');
  const commentPath = path.join(out, 'comment.md');
  if (comment) writeText(commentPath, comment);
  else rmSync(commentPath, { force: true });
  writeText(path.join(out, 'breaking'), breaking ? 'true\n' : 'false\n');
  writeText(path.join(out, 'fail-on'), `${config.failOn}\n`);

  let svgError = null;
  if (moduleDiff?.dot) {
    try {
      tryWriteSvg(path.join(out, 'module-graph.dot'), path.join(out, 'module-graph.svg'));
    } catch (err) {
      svgError = err;
    }
  } else {
    rmSync(path.join(out, 'module-graph.dot'), { force: true });
    rmSync(path.join(out, 'module-graph.svg'), { force: true });
  }

  const summaryFile = options.summaryFile ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, summaryText(report, { artifact: config.artifact }));
  const outputFile = options.outputFile ?? process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `breaking=${breaking ? 'true' : 'false'}\n`);
    appendFileSync(outputFile, `fail-on=${config.failOn}\n`);
    appendFileSync(outputFile, `artifact=${config.artifact}\n`);
  }

  if (options.pr && options.repo) {
    const event = options.event !== undefined ? options.event : readEvent();
    const client = options.client ?? (options.dryRun ? dryRunClient(options.log ?? console.log) : undefined);
    reconcile({
      repo: options.repo,
      pr: options.pr,
      body: comment,
      client,
      event,
      marker: config.marker,
      log: options.log ?? console.log,
    });
  }

  if (svgError) throw svgError;
  return { report, comment, breaking, moduleDiff, openApi, config };
}

function main(argv) {
  try {
    run(parseRunArgs(argv));
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
