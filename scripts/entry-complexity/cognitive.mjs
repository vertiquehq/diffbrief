// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Cognitive Complexity (G. Ann Campbell / SonarSource) over a blanked method body.
 * Ported from human-review's regex engine: approximate nesting via braces.
 */

const TOKEN = /\b(?:if|else|for|while|do|switch|catch)\b|&&|\|\||->|[{};?]/g;
const NESTS = new Set(['if', 'for', 'while', 'do', 'switch', 'catch']);
const CYC = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?/g;

/** @returns {Array<[number, number, string]>} offset, increment, why */
export function increments(body) {
  const hits = [];
  let nesting = 0;
  let pending = 0;
  const stack = [];
  let lastBool = null;
  let openedBy = '';
  let skipWhile = false;
  let skipIf = false;
  for (const m of body.matchAll(TOKEN)) {
    const t = m[0];
    const at = m.index;
    if (t === '{') {
      stack.push([pending, openedBy]);
      nesting += pending;
      pending = 0;
      openedBy = '';
      lastBool = null;
    } else if (t === '}') {
      if (stack.length) {
        const [added, by] = stack.pop();
        nesting -= added;
        skipWhile = by === 'do';
        lastBool = null;
      }
    } else if (t === ';') {
      pending = 0;
      lastBool = null;
    } else if (t === '&&' || t === '||') {
      if (lastBool !== t) hits.push([at, 1, t]);
      lastBool = t;
    } else if (t === '->') {
      pending = 1;
      openedBy = '->';
    } else if (t === '?') {
      const before = body[Math.max(0, at - 1)] ?? '';
      const after = body[at + 1] ?? '';
      if (!'<,'.includes(before) && !'>,'.includes(after)) {
        hits.push([at, 1 + nesting, '?:']);
      }
    } else if (t === 'else') {
      hits.push([at, 1, 'else']);
      pending = 1;
      openedBy = 'else';
      skipIf = true;
    } else if (t === 'while' && skipWhile) {
      skipWhile = false;
    } else if (t === 'if' && skipIf) {
      skipIf = false;
      pending = 1;
      openedBy = 'if';
    } else {
      skipIf = false;
      hits.push([at, 1 + nesting, t]);
      if (NESTS.has(t)) {
        pending = 1;
        openedBy = t;
      }
    }
  }
  return hits;
}

export function cognitive(body) {
  return increments(body).reduce((sum, [, inc]) => sum + inc, 0);
}

export function cyclomatic(body) {
  let n = 1;
  for (const m of body.matchAll(CYC)) {
    if (m[0] === '?') {
      const before = body[Math.max(0, m.index - 1)] ?? '';
      const after = body[m.index + 1] ?? '';
      if ('<,'.includes(before) || '>,'.includes(after)) continue;
    }
    n += 1;
  }
  return n;
}
