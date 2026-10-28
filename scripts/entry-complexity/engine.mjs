// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Approximate entry-point complexity from Java sources (human-review regex engine port).
 *
 * Follows typed method calls and method references in application source. Vertique
 * service-proxy calls look like interface methods and resolve to implementations;
 * raw EventBusClient / string addresses are not followed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cyclomatic, increments } from './cognitive.mjs';

const SRC = /(?:^|\/)src\/main\/java\/.+\.java$/;
const NOISE =
  /"""(?:\\.|[^\\])*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

const MODIFIER =
  '(?:public|protected|private|static|final|abstract|default|synchronized|native|strictfp)';
const TYPE = '[\\w.$]+(?:\\s*<[^<>;{}]*>)?(?:\\s*\\[\\s*\\])*';
const NEST3 = '\\([^();]*\\)';
const NEST2 = `\\((?:[^();]|${NEST3})*\\)`;
const NEST1 = `\\((?:[^();]|${NEST2})*\\)`;
const DECL = new RegExp(
  `(?:${MODIFIER}\\s+)*(?:<[^<>;{}]+>\\s*)?(?:(${TYPE})\\s+)?([A-Za-z_$]\\w*)\\s*` +
    `\\(((?:[^;{}()]|${NEST1})*)\\)\\s*(?:throws\\s[^{;]*)?\\{`,
  'g',
);

const NOT_A_METHOD = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'catch',
  'try',
  'return',
  'new',
  'synchronized',
  'assert',
  'yield',
  'instanceof',
  'class',
  'enum',
  'interface',
  'throw',
  'super',
  'this',
]);
const NOT_A_RETURN_TYPE = new Set([...NOT_A_METHOD, 'record']);

const TYPE_DECL = /\b(?:class|interface|enum|record|@interface)\s+(\w+)/;
const PACKAGE = /^\s*package\s+([\w.]+)\s*;/m;
const VAR =
  /\b([A-Z]\w*)(?:\s*<[^<>;{}]*>)?(?:\s*\[\s*\])?\s+([a-z_$]\w*)\s*(?=[;=,):])/g;
const CONST = /\b([A-Z]\w*)(?:\s*<[^<>;{}]*>)?\s+([A-Z][A-Z0-9_]*)\s*(?==)/g;
const CALL = /(?:(\w+)\s*\.\s*)?\b([A-Za-z_$]\w*)\s*\(/g;
const METHOD_REF = /\b(\w+)\s*::\s*(new\b|[A-Za-z_$]\w*)/g;
const ANNOT = /@(\w+)\s*(\((?:[^()]|\([^()]*\))*\))?/g;
const STRING = /"([^"\\\n]*)"/;
const IMPLEMENTS = /\bimplements\s+([^{]+)/;

export const ENGINE_ID = 'diffbrief-source/1';
export const SCHEMA_VERSION = 1;

const BUILTIN_PACK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'packs',
  'vertique.json',
);

export function strip(text) {
  return text.replace(NOISE, (m) => m.replace(/[^\n]/g, ' '));
}

function blockEnd(code, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < code.length; i++) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

function callsIn(body) {
  const found = new Set();
  for (const m of body.matchAll(CALL)) {
    const called = m[2];
    if (NOT_A_METHOD.has(called)) continue;
    found.add(`${m[1] || ''}\0${called}`);
  }
  for (const m of body.matchAll(METHOD_REF)) {
    const called = m[2] === 'new' ? m[1] : m[2];
    found.add(`${m[1]}\0${called}`);
  }
  return [...found].map((s) => {
    const [recv, called] = s.split('\0');
    return [recv, called];
  });
}

const STRING_CONST =
  /\b(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?String\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/g;

/** Collect `String CONST = "..."` (and Type.CONST) for annotation value resolution. */
export function collectStringConstants(files) {
  const bySimple = new Map(); // CONST -> value (last wins if clash)
  const byQualified = new Map(); // Type.CONST -> value
  for (const text of Object.values(files)) {
    const code = strip(text);
    const decl = TYPE_DECL.exec(code);
    const typeName = decl ? decl[1] : null;
    for (const m of text.matchAll(STRING_CONST)) {
      bySimple.set(m[1], m[2]);
      if (typeName) byQualified.set(`${typeName}.${m[1]}`, m[2]);
    }
  }
  return { bySimple, byQualified };
}

function annotValue(args, names, constants = null) {
  const text = args || '';
  for (const name of names) {
    const lit = text.match(new RegExp(`\\b${name}\\s*=\\s*\\{?\\s*"([^"]*)"`));
    if (lit) return lit[1];
    const ref = text.match(new RegExp(`\\b${name}\\s*=\\s*([A-Za-z_][\\w.]*)`));
    if (ref && constants) {
      const token = ref[1];
      if (constants.byQualified.has(token)) return constants.byQualified.get(token);
      const simple = token.includes('.') ? token.split('.').pop() : token;
      if (constants.bySimple.has(simple)) return constants.bySimple.get(simple);
    }
  }
  if (!/\w+\s*=/.test(text)) {
    const m = STRING.exec(text);
    if (m) return m[1];
  }
  return '';
}

function joinPath(prefix, suffix) {
  const parts = `${prefix || ''}/${suffix || ''}`.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

function paramsDisplay(params) {
  const bare = params.replace(/@\w+\s*(\((?:[^()]|\([^()]*\))*\))?/g, ' ').trim();
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of `${bare},`) {
    if (ch === '<' || ch === '(') depth += 1;
    else if (ch === '>' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      const words = cur.replace(/<[^<>]*>/g, '').trim().split(/\s+/).filter(Boolean);
      if (words.length) out.push(words[0].split('.').pop());
      cur = '';
    } else {
      cur += ch;
    }
  }
  return out.join(', ');
}

function loadPackFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Resolve profile + optional pack paths relative to actionRoot / cwd. */
export function loadPacks({ profile = 'vertique', packs = [], actionRoot } = {}) {
  const loaded = [];
  if (profile === 'vertique' || profile == null) {
    loaded.push(loadPackFile(BUILTIN_PACK));
  } else if (profile && profile !== 'none') {
    throw new Error(`unknown entry-complexity profile: ${profile}`);
  }
  for (const rel of packs) {
    const candidates = [
      path.resolve(rel),
      actionRoot ? path.join(actionRoot, rel) : null,
      path.join(process.cwd(), rel),
    ].filter(Boolean);
    const hit = candidates.find((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!hit) throw new Error(`entry-complexity pack not found: ${rel}`);
    loaded.push(loadPackFile(hit));
  }
  return mergePacks(loaded);
}

function mergePacks(packs) {
  const annotations = [];
  const classPathAnnotations = [];
  const methodPathAnnotations = [];
  const seenAnn = new Set();
  for (const pack of packs) {
    for (const a of pack.annotations ?? []) {
      const key = `${a.name}|${a.kind}|${a.httpMethod ?? ''}`;
      if (seenAnn.has(key)) continue;
      seenAnn.add(key);
      annotations.push(a);
    }
    for (const a of pack.classPathAnnotations ?? []) classPathAnnotations.push(a);
    for (const a of pack.methodPathAnnotations ?? []) methodPathAnnotations.push(a);
  }
  return { annotations, classPathAnnotations, methodPathAnnotations };
}

function entryFromAnnots(annots, pack, classPath, constants) {
  let kind = null;
  let httpMethod = null;
  let pathSuffix = '';
  let methodPath = '';

  for (const [name, args] of annots) {
    for (const rule of pack.methodPathAnnotations) {
      if (rule.name === name) {
        methodPath =
          annotValue(args, rule.pathArgs ?? ['value', 'path'], constants) || methodPath;
      }
    }
    for (const rule of pack.annotations) {
      if (rule.name !== name) continue;
      kind = rule.kind;
      httpMethod = rule.httpMethod ?? 'ANY';
      if (rule.methodEnum && args) {
        const m = args.match(
          new RegExp(`method\\s*=\\s*(?:\\{\\s*)?${rule.methodEnum}\\.(\\w+)`),
        );
        if (m) httpMethod = m[1];
      }
      const fromArgs = annotValue(
        args,
        rule.pathArgs ?? ['value', 'path', 'name', 'topic'],
        constants,
      );
      if (fromArgs) pathSuffix = fromArgs;
    }
  }

  if (!kind) return null;

  if (kind === 'http') {
    const prefix = classPath || '';
    const suffix = methodPath || pathSuffix;
    return {
      kind,
      httpMethod,
      path: joinPath(prefix, suffix),
    };
  }
  return {
    kind,
    httpMethod,
    path: pathSuffix || methodPath || '',
  };
}

function classPathFromAnnots(annots, pack, constants) {
  for (const [name, args] of annots) {
    for (const rule of pack.classPathAnnotations) {
      if (rule.name === name) {
        return annotValue(args, rule.pathArgs ?? ['value', 'path'], constants);
      }
    }
  }
  return '';
}

function parseAnnots(text) {
  const out = [];
  for (const m of text.matchAll(ANNOT)) {
    out.push([m[1], m[2] || '']);
  }
  return out;
}

function collectSources(root, listDir = readdirSync) {
  const files = {};
  const walk = (dir) => {
    let entries;
    try {
      entries = listDir(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (name === '.git' || name === 'target' || name === 'node_modules' || name === '.human-review') {
        continue;
      }
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!SRC.test(rel)) continue;
      files[rel] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

function callsBack(body, name, simple) {
  const own = new Set(['', 'this', simple]);
  for (const m of body.matchAll(CALL)) {
    const recv = m[1] || '';
    if (m[2] !== name) continue;
    if (!own.has(recv)) continue;
    if (!recv && body.slice(0, m.index).trimEnd().endsWith('.')) continue;
    return m.index;
  }
  for (const m of body.matchAll(METHOD_REF)) {
    if (m[2] === name && own.has(m[1])) return m.index;
  }
  return null;
}

export class Index {
  constructor(files, pack) {
    this.pack = pack;
    this.constants = collectStringConstants(files);
    this.methods = new Map();
    this.byName = new Map();
    this.ofClass = new Map();
    this.classes = new Map();
    this.implements = new Map();
    this.entries = [];
    for (const [filePath, text] of Object.entries(files)) {
      this._read(filePath, text);
    }
  }

  _read(filePath, text) {
    const code = strip(text);
    const pkgMatch = PACKAGE.exec(code);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    const decl = TYPE_DECL.exec(code);
    if (!decl) return;
    // `@interface Name` also matches the `interface Name` alternative; skip annotation types.
    if (decl.index > 0 && code[decl.index - 1] === '@') return;

    const simple = decl[1];
    const fqcn = pkg ? `${pkg}.${simple}` : simple;
    this.classes.set(simple, fqcn);

    const implMatch = IMPLEMENTS.exec(code.slice(decl.index, decl.index + 400));
    if (implMatch) {
      const ifaces = implMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/<.*>/, '').split('.').pop())
        .filter(Boolean);
      this.implements.set(fqcn, ifaces);
    }

    const beforeType =
      Math.max(code.lastIndexOf('}', decl.index), code.lastIndexOf(';', decl.index), 0) + 1;
    const classAnnots = parseAnnots(text.slice(beforeType, decl.index));
    const classPath = classPathFromAnnots(classAnnots, this.pack, this.constants);

    const types = new Map();
    for (const m of code.matchAll(VAR)) types.set(m[2], m[1]);
    for (const m of code.matchAll(CONST)) types.set(m[2], m[1]);

    DECL.lastIndex = decl.index + decl[0].length;
    let m;
    while ((m = DECL.exec(code))) {
      const ret = m[1];
      const name = m[2];
      const params = m[3];
      if (NOT_A_METHOD.has(name)) continue;
      if (ret && NOT_A_RETURN_TYPE.has(ret.split('<')[0].trim())) continue;
      const at = m.index + m[0].length - 1;
      const body = code.slice(at, blockEnd(code, at));
      const key = `${fqcn}#${name}`;
      const calls = callsIn(body);
      let method = this.methods.get(key);
      if (!method) {
        method = {
          key,
          display: `${simple}.${name}(${paramsDisplay(params)})`,
          cc: 0,
          cyc: 0,
          calls: [],
          types,
          file: filePath,
        };
        this.methods.set(key, method);
      }
      const hits = increments(body);
      let cc = hits.reduce((s, [, inc]) => s + inc, 0);
      const back = callsBack(body, name, simple);
      if (back != null) cc += 1;
      method.cc += cc;
      method.cyc += cyclomatic(body);
      method.calls = [...new Set([...method.calls.map((c) => c.join('\0')), ...calls.map((c) => c.join('\0'))])].map(
        (s) => s.split('\0'),
      );

      if (!this.byName.has(name)) this.byName.set(name, []);
      if (!this.byName.get(name).includes(key)) this.byName.get(name).push(key);
      if (!this.ofClass.has(fqcn)) this.ofClass.set(fqcn, new Map());
      this.ofClass.get(fqcn).set(name, key);

      const annotStart = Math.max(code.lastIndexOf(';', m.index), code.lastIndexOf('{', m.index), code.lastIndexOf('}', m.index)) + 1;
      const annots = parseAnnots(text.slice(annotStart, m.index));
      const entry = entryFromAnnots(annots, this.pack, classPath, this.constants);
      if (entry) {
        const pathLabel =
          entry.kind === 'http'
            ? entry.path
            : entry.path || method.display.split('(')[0];
        this.entries.push({
          kind: entry.kind,
          httpMethod: entry.httpMethod,
          path: pathLabel,
          handler: method.display,
          key,
        });
      }
    }
  }

  resolve(method, recv, called) {
    if (!recv || recv === 'this') {
      const ownerFq = method.key.split('#')[0];
      const own = this.ofClass.get(ownerFq)?.get(called);
      if (own) return [own];
      return this._unique(called);
    }
    const ownerSimple = method.types.get(recv) || this.classes.get(recv);
    if (ownerSimple) {
      const fq = this.classes.get(ownerSimple) || ownerSimple;
      const here = this.ofClass.get(fq)?.get(called);
      if (here) return [here];
      // Interface / type with no body here: all project methods of that name except on fq.
      if ([...this.classes.values()].includes(fq) || this.classes.has(ownerSimple)) {
        return (this.byName.get(called) ?? []).filter((k) => k.split('#')[0] !== fq);
      }
      return [];
    }
    if (/^[A-Z]/.test(recv)) return [];
    return this._unique(called);
  }

  _unique(called) {
    const keys = this.byName.get(called) ?? [];
    return keys.length === 1 ? keys : [];
  }

  callees(key) {
    const method = this.methods.get(key);
    if (!method) return [];
    const out = [];
    for (const [recv, called] of [...method.calls].sort((a, b) => `${a}`.localeCompare(`${b}`))) {
      for (const target of this.resolve(method, recv, called)) {
        if (target !== key && !out.includes(target)) out.push(target);
      }
    }
    return out;
  }

  flow(key) {
    const seen = new Set([key]);
    const queue = [key];
    const order = [];
    while (queue.length) {
      const cur = queue.shift();
      if (!this.methods.has(cur)) continue;
      order.push(cur);
      for (const target of this.callees(cur)) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return order;
  }
}

export function entryId(entry) {
  if (entry.kind === 'http') return `http:${entry.httpMethod}:${entry.path}`;
  if (entry.kind === 'mcp') return `mcp:${entry.path || entry.handler}`;
  if (entry.kind === 'listener') return `listener:${entry.httpMethod}:${entry.path || entry.handler}`;
  if (entry.kind === 'job') return `job:${entry.path || entry.handler}`;
  return `${entry.kind}:${entry.path || entry.handler}`;
}

export function extract(files, pack) {
  const index = new Index(files, pack);
  const out = [];
  for (const e of index.entries) {
    const flow = index.flow(e.key);
    const inFlow = new Set(flow);
    const flowCc = flow.reduce((s, k) => s + (index.methods.get(k)?.cc ?? 0), 0);
    out.push({
      id: entryId(e),
      kind: e.kind,
      httpMethod: e.httpMethod,
      path: e.path,
      handler: e.handler,
      key: e.key,
      metric: 'cognitive',
      flowCc,
      methods: flow.length,
      flow: flow.map((k) => {
        const meth = index.methods.get(k);
        return {
          method: k,
          display: meth.display,
          cognitive: meth.cc,
          cyclomatic: meth.cyc,
          calls: index.callees(k).filter((t) => inFlow.has(t)),
        };
      }),
    });
  }
  out.sort((a, b) => b.flowCc - a.flowCc || a.path.localeCompare(b.path));
  return out;
}

/**
 * Build a schema v1 snapshot for a checkout root.
 * @param {string} root
 * @param {{ profile?: string, packs?: string[], kinds?: string[], actionRoot?: string, listDir?: Function }} options
 */
export function snapshotCheckout(root, options = {}) {
  const pack = loadPacks({
    profile: options.profile ?? 'vertique',
    packs: options.packs ?? [],
    actionRoot: options.actionRoot,
  });
  const files = collectSources(root, options.listDir ?? readdirSync);
  let entries = extract(files, pack);
  if (options.kinds?.length) {
    const allow = new Set(options.kinds);
    entries = entries.filter((e) => allow.has(e.kind));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    metric: 'cognitive',
    engine: ENGINE_ID,
    root: path.resolve(root),
    entries,
  };
}
