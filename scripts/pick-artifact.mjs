// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/** Read artifacts JSON from stdin; print the chosen artifact id. */

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(0, 'utf8'));
const name = process.env.ARTIFACT_NAME || '';
const sha = process.env.EXPECTED_SHA || '';
if (!sha) throw new Error('EXPECTED_SHA is required');
const arts = (Array.isArray(data) ? data.flatMap((page) => page.artifacts || []) : data.artifacts || []).filter((a) => !a.expired && (!name || a.name === name));
const match = arts.find((a) => a.workflow_run?.head_sha === sha);
if (!match) {
  console.error(`download-workflow-artifact: no artifact named ${name || '(any)'} for commit ${sha}`);
  process.exit(2);
}
process.stdout.write(String(match.id));
