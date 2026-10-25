// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/**
 * Fail the job when a producer reported a breaking change and the consumer
 * config asks for that. Reads OUT_DIR/breaking and OUT_DIR/fail-on (written
 * by run.mjs). Missing files mean no failure. fail-on=never always exits 0.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function shouldFail({ breaking, failOn }) {
  if (failOn === 'never') return false;
  return breaking === true || breaking === 'true';
}

function readTrimmed(file) {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trim();
}

function main(env = process.env) {
  const out = env.OUT_DIR || path.join(process.cwd(), 'diffbrief-out');
  const breaking = readTrimmed(path.join(out, 'breaking'));
  const failOn = readTrimmed(path.join(out, 'fail-on')) || 'breaking';
  if (shouldFail({ breaking, failOn })) {
    console.error('diffbrief: breaking changes reported');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
