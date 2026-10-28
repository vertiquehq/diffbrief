// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * OpenAPI diff between two directories of collected spec files.
 *
 * oasdiff is the only differ (same conclusion as human-review's eval against a
 * home-grown classifier). Each pair is compared with `oasdiff changelog`:
 * JSON for the verdict and counts, markdown for the readable details. External
 * $refs are refused so an untrusted pull request cannot make the runner fetch
 * arbitrary URLs. The job's breaking bit is ERR-level findings only (level 3);
 * WARN (level 2) is reported as "possibly breaking" in the verdict band.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { cmp } from './util.mjs';

export const LEVEL_ERR = 3;
export const LEVEL_WARN = 2;
export const LEVEL_INFO = 1;

export const VERDICT = {
  NO_CHANGES: 'no_changes',
  COMPATIBLE: 'compatible',
  INCOMPATIBLE: 'incompatible',
  NOT_RUN: 'not_run',
};

export const VERDICT_HEADLINE = {
  [VERDICT.NO_CHANGES]: 'The contract did not move',
  [VERDICT.COMPATIBLE]: 'Backward compatible',
  [VERDICT.INCOMPATIBLE]: 'Not backward compatible',
  [VERDICT.NOT_RUN]: 'The compatibility check did not run',
};

/** Flags every oasdiff invocation gets. Never pass --open (uploads specs). */
export const OASDIFF_SAFE_FLAGS = ['--allow-external-refs=false'];

export function runCaptured(bin, args, exec = execFileSync) {
  try {
    const stdout = exec(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`oasdiff executable not found: ${bin}`);
    if (typeof err?.status !== 'number') throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

/** True when oasdiff printed no API changes. A title plus "No changes detected" counts as empty. */
export function changelogIsEmpty(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('# API Changelog'))
    .filter((line) => line !== 'No changes detected');
  return lines.length === 0;
}

export function parseChangelogJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`oasdiff changelog JSON was not valid: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('oasdiff changelog JSON must be an array');
  return parsed;
}

function listSpecs(dir, listDir) {
  const found = new Map();
  if (!dir) return found;
  const walk = (current) => {
    let entries;
    try {
      entries = listDir(current);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of [...entries].map((item) => (typeof item === 'string' ? item : item.name)).sort(cmp)) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry === 'openapi.yaml' || entry === 'openapi.yml') {
        const rel = path.relative(dir, full).split(path.sep).join('/').replace(/\.yml$/, '.yaml');
        if (found.has(rel)) throw new Error(`duplicate OpenAPI document: ${rel}`);
        found.set(rel, full);
      }
    }
  };
  walk(dir);
  return found;
}

function scrub(text, pairs) {
  let out = String(text);
  for (const [from, to] of pairs) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}

function endpointKey(change) {
  const op = change.operation ? String(change.operation).toUpperCase() : '';
  const p = change.path ? String(change.path) : '';
  if (op || p) return `${op} ${p}`.trim();
  return '';
}

export function summarizeChanges(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const endpoints = new Set();
  let err = 0;
  let warn = 0;
  let info = 0;
  for (const change of list) {
    const level = Number(change.level) || 0;
    if (level >= LEVEL_ERR) err += 1;
    else if (level === LEVEL_WARN) warn += 1;
    else if (level >= LEVEL_INFO) info += 1;
    const key = endpointKey(change);
    if (key) endpoints.add(key);
  }
  return {
    changes: list.length,
    endpoints: endpoints.size,
    err,
    warn,
    info,
    breakingText: list
      .filter((change) => Number(change.level) >= LEVEL_ERR)
      .map((change) => String(change.text || change.id || '').trim())
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Aggregate verdict across every compared or added/removed document.
 * Removed whole documents count as incompatible even when oasdiff did not run.
 */
export function apiVerdict(diff, { baseBuildFailed = false } = {}) {
  if (baseBuildFailed) {
    return {
      kind: VERDICT.NOT_RUN,
      headline: VERDICT_HEADLINE[VERDICT.NOT_RUN],
      endpoints: 0,
      err: 0,
      warn: 0,
      info: 0,
      newDocs: 0,
      removedDocs: 0,
      checkedBy: 'oasdiff',
    };
  }
  if (!diff) {
    return {
      kind: VERDICT.NOT_RUN,
      headline: VERDICT_HEADLINE[VERDICT.NOT_RUN],
      endpoints: 0,
      err: 0,
      warn: 0,
      info: 0,
      newDocs: 0,
      removedDocs: 0,
      checkedBy: 'oasdiff',
    };
  }
  let endpoints = 0;
  let err = 0;
  let warn = 0;
  let info = 0;
  let newDocs = 0;
  let removedDocs = 0;
  let moved = false;
  for (const run of diff.runs ?? []) {
    if (run.kind === 'unchanged') continue;
    moved = true;
    if (run.kind === 'new') {
      newDocs += 1;
      continue;
    }
    if (run.kind === 'removed') {
      removedDocs += 1;
      continue;
    }
    const summary = run.summary ?? summarizeChanges(run.changes);
    endpoints += summary.endpoints;
    err += summary.err;
    warn += summary.warn;
    info += summary.info;
  }
  let kind = VERDICT.NO_CHANGES;
  if (!moved) kind = VERDICT.NO_CHANGES;
  else if (err > 0 || removedDocs > 0 || diff.breaking) kind = VERDICT.INCOMPATIBLE;
  else kind = VERDICT.COMPATIBLE;
  return {
    kind,
    headline: VERDICT_HEADLINE[kind],
    endpoints,
    err,
    warn,
    info,
    newDocs,
    removedDocs,
    checkedBy: 'oasdiff',
  };
}

/**
 * @param {{ baseDir?: string, headDir?: string, bin?: string, execFile?: Function, listDir?: Function }} options
 */
export function diffOpenApi(options = {}) {
  const bin = options.bin || process.env.OASDIFF_BIN || 'oasdiff';
  const execFile = options.execFile;
  const listDir = options.listDir ?? readdirSync;
  const baseFiles = listSpecs(options.baseDir, listDir);
  const headFiles = listSpecs(options.headDir, listDir);
  const keys = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort(cmp);
  const sections = [];
  const runs = [];
  let breaking = false;

  for (const key of keys) {
    const baseFile = baseFiles.get(key);
    const headFile = headFiles.get(key);
    if (baseFile && headFile) {
      const jsonRun = runCaptured(
        bin,
        ['changelog', baseFile, headFile, '--format', 'json', ...OASDIFF_SAFE_FLAGS],
        execFile,
      );
      const mdRun = runCaptured(
        bin,
        ['changelog', baseFile, headFile, '--format', 'markdown', ...OASDIFF_SAFE_FLAGS],
        execFile,
      );
      for (const result of [jsonRun, mdRun]) {
        if (result.status !== 0) throw new Error(`oasdiff failed for ${key} (exit ${result.status}): ${result.stderr}`);
      }
      const replacements = [
        [baseFile, key],
        [headFile, key],
      ];
      const changes = parseChangelogJson(scrub(jsonRun.stdout, replacements));
      const summary = summarizeChanges(changes);
      const changelogText = scrub(mdRun.stdout, replacements);
      const empty = changelogIsEmpty(changelogText) && changes.length === 0;
      if (summary.err > 0) breaking = true;
      runs.push({
        path: key,
        kind: empty ? 'unchanged' : 'changed',
        changelogStatus: mdRun.status,
        breakingStatus: summary.err > 0 ? 1 : 0,
        changelog: changelogText,
        breakingText: summary.breakingText,
        changes,
        summary,
      });
      if (!empty) {
        sections.push({
          path: key,
          kind: 'changed',
          markdown: changelogText.trim(),
          breaking: summary.err > 0,
          breakingText: summary.breakingText,
          summary,
        });
      }
      continue;
    }
    if (headFile) {
      runs.push({
        path: key,
        kind: 'new',
        changelogStatus: null,
        breakingStatus: null,
        changelog: '',
        breakingText: '',
        changes: [],
        summary: summarizeChanges([]),
      });
      sections.push({ path: key, kind: 'new', markdown: 'new API document', breaking: false, breakingText: '' });
      continue;
    }
    runs.push({
      path: key,
      kind: 'removed',
      changelogStatus: null,
      breakingStatus: null,
      changelog: '',
      breakingText: '',
      changes: [],
      summary: summarizeChanges([]),
    });
    // Whole-document removal is a contract break for the verdict; the job still
    // fails only on oasdiff ERR so a removed file alone does not flip breaking.
    sections.push({ path: key, kind: 'removed', markdown: 'removed API document', breaking: false, breakingText: '' });
  }

  const verdict = apiVerdict({ breaking, sections, runs });
  return { breaking, sections, runs, verdict };
}
