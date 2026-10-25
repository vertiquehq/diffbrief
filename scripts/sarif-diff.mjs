// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Diff two SARIF reports (base vs head) and list findings introduced on head.
 *
 * This is how SAST tools plug into diffbrief: run PMD / SpotBugs / CodeQL /
 * Semgrep in CI (or the official PMD GitHub Action), write SARIF, then point
 * this producer at the two files. Diffbrief does not run PMD itself — PMD's
 * useful outputs for review are SARIF (rule violations) and optionally CPD
 * XML for duplication; CPD has no stable SARIF yet (pmd#4632), so duplication
 * stays a separate command producer if needed.
 *
 * Fingerprint: ruleId + primary location URI + startLine + message text.
 */

import { existsSync, readFileSync } from 'node:fs';

import { cmp, inlineCode } from './util.mjs';

function loadSarif(file) {
  if (!file || !existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const findings = [];
  for (const run of doc.runs ?? []) {
    for (const result of run.results ?? []) {
      const loc = result.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri || '';
      const line = loc?.region?.startLine ?? 0;
      const ruleId = result.ruleId || result.rule?.id || 'unknown';
      const level = result.level || 'warning';
      const message = result.message?.text || '';
      const fingerprint = `${ruleId}|${uri}|${line}|${message}`;
      findings.push({ fingerprint, ruleId, level, uri, line, message });
    }
  }
  return findings;
}

/**
 * @param {{ baseSarif?: string, headSarif?: string, breakOnLevels?: string[] }} options
 */
export function diffSarif(options = {}) {
  const breakOnLevels = new Set(
    (options.breakOnLevels ?? ['error', 'critical']).map((l) => String(l).toLowerCase()),
  );
  const base = loadSarif(options.baseSarif);
  const head = loadSarif(options.headSarif);
  const baseSet = new Set(base.map((f) => f.fingerprint));
  const introduced = head.filter((f) => !baseSet.has(f.fingerprint)).sort((a, b) => {
    return cmp(a.ruleId, b.ruleId) || cmp(a.uri, b.uri) || cmp(a.line, b.line);
  });
  const resolved = base.filter((f) => !head.some((h) => h.fingerprint === f.fingerprint));

  if (introduced.length === 0 && resolved.length === 0) {
    return { markdown: '', breaking: false, checked: true, introduced, resolved };
  }

  const lines = [];
  if (introduced.length) {
    lines.push('| Severity | Rule | Location | Message |', '| --- | --- | --- | --- |');
    for (const f of introduced) {
      const loc = f.uri ? `${f.uri}:${f.line || '?'}` : '—';
      lines.push(
        `| ${inlineCode(f.level)} | ${inlineCode(f.ruleId)} | ${inlineCode(loc)} | ${inlineCode(f.message).slice(0, 120)} |`,
      );
    }
    lines.push('');
  }
  if (resolved.length) {
    lines.push(`Resolved since base: ${resolved.length} finding(s).`, '');
  }
  const breaking = introduced.some((f) => breakOnLevels.has(String(f.level).toLowerCase()));
  return {
    markdown: `${lines.join('\n')}\n`,
    breaking,
    checked: true,
    introduced,
    resolved,
  };
}
