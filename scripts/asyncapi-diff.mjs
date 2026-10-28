// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff AsyncAPI documents with the AsyncAPI CLI (`asyncapi diff`).
 *
 * oasdiff does not support AsyncAPI. The CLI wraps `@asyncapi/diff` and
 * classifies breaking / non-breaking / unclassified changes. Specs are
 * discovered by glob (default: asyncapi.yaml / asyncapi.yml / asyncapi.json)
 * or listed explicitly. Binary: ASYNCAPI_BIN or asyncapi on PATH
 * (often npx @asyncapi/cli).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { matchGlob } from './config.mjs';
import { cmp, inlineCode } from './util.mjs';

export const DEFAULT_ASYNCAPI_GLOBS = ['**/asyncapi.yaml', '**/asyncapi.yml', '**/asyncapi.json'];

function listSpecs(root, globs, listDir) {
  const found = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = listDir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of [...entries].map((item) => (typeof item === 'string' ? item : item.name)).sort(cmp)) {
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === '.git' || entry === 'target' || entry === 'node_modules') continue;
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (globs.some((g) => matchGlob(g, rel))) found.set(rel, full);
    }
  };
  walk(root);
  return found;
}

function runCaptured(bin, args, exec) {
  try {
    const stdout = exec(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`asyncapi executable not found: ${bin}`);
    if (typeof err?.status !== 'number') throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

function parseBreakingJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('asyncapi returned empty breaking JSON');
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    return parsed;
  } catch (err) {
    throw new Error(`invalid asyncapi breaking JSON: ${err.message}`);
  }
}

/**
 * @param {{ baseRoot: string, headRoot: string, bin?: string, globs?: string[], specs?: string[], execFile?: Function, listDir?: Function }} options
 */
export function diffAsyncApi(options = {}) {
  const bin = options.bin || process.env.ASYNCAPI_BIN || 'asyncapi';
  const execFile = options.execFile ?? execFileSync;
  const listDir = options.listDir ?? readdirSync;
  const globs = options.globs?.length ? options.globs : DEFAULT_ASYNCAPI_GLOBS;

  let baseFiles;
  let headFiles;
  if (options.specs?.length) {
    baseFiles = new Map(options.specs.filter((rel) => existsSync(path.join(options.baseRoot, rel))).map((rel) => [rel, path.join(options.baseRoot, rel)]));
    headFiles = new Map(options.specs.filter((rel) => existsSync(path.join(options.headRoot, rel))).map((rel) => [rel, path.join(options.headRoot, rel)]));
  } else {
    baseFiles = listSpecs(options.baseRoot, globs, listDir);
    headFiles = listSpecs(options.headRoot, globs, listDir);
  }

  const keys = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort(cmp);
  const sections = [];
  let breaking = false;

  for (const key of keys) {
    const baseFile = baseFiles.get(key);
    const headFile = headFiles.get(key);
    if (baseFile && headFile) {
      const md = runCaptured(
        bin,
        ['diff', baseFile, headFile, '-f', 'md', '-t', 'all', '--no-error'],
        execFile,
      );
      const br = runCaptured(
        bin,
        ['diff', baseFile, headFile, '-f', 'json', '-t', 'breaking', '--no-error'],
        execFile,
      );
      for (const result of [md, br]) {
        if (result.status !== 0) throw new Error(`asyncapi failed for ${key} (exit ${result.status}): ${result.stderr}`);
      }
      const breakingItems = parseBreakingJson(br.stdout);
      const hasBreaking = breakingItems.length > 0;
      if (hasBreaking) breaking = true;
      const body = String(md.stdout || '').trim();
      if (!body && !hasBreaking) continue;
      let block = `### ${inlineCode(key)}\n\n`;
      if (hasBreaking) {
        block += `Breaking changes: ${breakingItems.length}\n\n`;
        for (const item of breakingItems.slice(0, 40)) {
          const text = item?.message || item?.path || JSON.stringify(item);
          block += `- ${inlineCode(text)}\n`;
        }
        block += '\n';
      }
      if (body) block += `<details>\n<summary>AsyncAPI changelog</summary>\n\n${body}\n\n</details>\n`;
      sections.push(block);
      continue;
    }
    if (headFile) {
      sections.push(`### ${inlineCode(key)}\n\nnew AsyncAPI document\n`);
      continue;
    }
    sections.push(`### ${inlineCode(key)}\n\nremoved AsyncAPI document\n`);
    breaking = true;
  }

  return {
    markdown: sections.join('\n'),
    breaking,
    checked: true,
  };
}
