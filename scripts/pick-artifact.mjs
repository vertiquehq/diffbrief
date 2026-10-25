// SPDX-FileCopyrightText: 2026 Koivisto Capital Oy
// SPDX-License-Identifier: EUPL-1.2

/** Read artifacts JSON from stdin; print the chosen artifact id. */

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(0, 'utf8'));
const name = process.env.ARTIFACT_NAME || '';
const branch = process.env.BRANCH || '';
const arts = (data.artifacts || []).filter((a) => !a.expired && (!name || a.name === name));
const match = arts.find((a) => !branch || a.workflow_run?.head_branch === branch) || arts[0];
if (!match) {
  console.error(`download-workflow-artifact: no artifact named ${name || '(any)'}`);
  process.exit(2);
}
process.stdout.write(String(match.id));
