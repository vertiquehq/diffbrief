// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Package Playwright videos / traces for the review comment and artifact.
 *
 * Diffbrief does not run Playwright. The consumer CI records video/trace
 * (or downloads a prior job's test-results artifact into resultsDir), then
 * this producer copies matching media into the out directory and writes a
 * markdown section with relative links reviewers can open from the artifact.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { matchGlob } from './config.mjs';
import { cmp, inlineCode } from './util.mjs';

export const DEFAULT_VIDEO_GLOBS = ['**/*.webm', '**/*.mp4', '**/*.mkv'];
export const DEFAULT_TRACE_GLOBS = ['**/*.zip'];
export const DEFAULT_RESULTS_DIRS = ['test-results', 'playwright-report'];

function walk(root, listDir) {
  const files = [];
  const visit = (dir) => {
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
        if (entry === 'node_modules' || entry === '.git') continue;
        visit(full);
      } else {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

function safeName(rel) {
  return rel.replace(/[^A-Za-z0-9._/-]+/g, '_').replace(/\.\./g, '_');
}

/**
 * @param {{
 *   headRoot: string,
 *   outDir: string,
 *   resultsDirs?: string[],
 *   videoGlobs?: string[],
 *   traceGlobs?: string[],
 *   maxVideos?: number,
 *   maxTraces?: number,
 *   pathFilter?: string[],
 *   listDir?: Function,
 * }} options
 */
export function packagePlaywright(options = {}) {
  const listDir = options.listDir ?? readdirSync;
  const resultsDirs = options.resultsDirs?.length ? options.resultsDirs : DEFAULT_RESULTS_DIRS;
  const videoGlobs = options.videoGlobs?.length ? options.videoGlobs : DEFAULT_VIDEO_GLOBS;
  const traceGlobs = options.traceGlobs?.length ? options.traceGlobs : DEFAULT_TRACE_GLOBS;
  const maxVideos = options.maxVideos ?? 10;
  const maxTraces = options.maxTraces ?? 10;
  const pathFilter = (options.pathFilter ?? []).map((p) => String(p).replace(/\\/g, '/'));

  const mediaRoot = path.join(options.outDir, 'playwright');
  mkdirSync(mediaRoot, { recursive: true });

  const videos = [];
  const traces = [];

  for (const relDir of resultsDirs) {
    const abs = path.isAbsolute(relDir) ? relDir : path.join(options.headRoot, relDir);
    if (!existsSync(abs)) continue;
    for (const full of walk(abs, listDir)) {
      const rel = path.relative(abs, full).split(path.sep).join('/');
      const fromHead = path.relative(options.headRoot, full).split(path.sep).join('/');
      if (pathFilter.length && !pathFilter.some((f) => fromHead.includes(f) || rel.includes(f))) {
        continue;
      }
      if (videoGlobs.some((g) => matchGlob(g, rel) || matchGlob(g, fromHead))) videos.push({ full, rel: fromHead });
      else if (traceGlobs.some((g) => matchGlob(g, rel) || matchGlob(g, fromHead))) traces.push({ full, rel: fromHead });
    }
  }

  videos.sort((a, b) => cmp(a.rel, b.rel));
  traces.sort((a, b) => cmp(a.rel, b.rel));

  const keptVideos = videos.slice(0, maxVideos);
  const keptTraces = traces.slice(0, maxTraces);
  const copied = [];

  for (const item of [...keptVideos, ...keptTraces]) {
    const destRel = safeName(item.rel);
    const dest = path.join(mediaRoot, destRel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(item.full, dest);
    copied.push({
      source: item.rel,
      artifact: path.join('playwright', destRel).split(path.sep).join('/'),
      kind: keptVideos.includes(item) ? 'video' : 'trace',
    });
  }

  if (copied.length === 0) {
    return { markdown: '', breaking: false, checked: true, copied };
  }

  const lines = [
    'Playwright media from this run (open from the `diffbrief` artifact):',
    '',
    '| Kind | Source | Artifact path |',
    '| --- | --- | --- |',
  ];
  for (const item of copied) {
    lines.push(`| ${item.kind} | ${inlineCode(item.source)} | ${inlineCode(item.artifact)} |`);
  }
  if (videos.length > maxVideos || traces.length > maxTraces) {
    lines.push(
      '',
      `_Showing ${keptVideos.length}/${videos.length} videos and ${keptTraces.length}/${traces.length} traces._`,
    );
  }
  writeFileSync(path.join(mediaRoot, 'index.md'), `${lines.join('\n')}\n`);
  return {
    markdown: `${lines.join('\n')}\n`,
    breaking: false,
    checked: true,
    copied,
  };
}
