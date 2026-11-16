// markfast harness driver.
//
// The grader drops the case set at /input/cases.json and expects the
// rendered HTML at /output/html.json, one string per case, in order.
// Locally, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR point at stand-ins for
// those two directories. Each case is rendered on its own: parse() keeps
// no state between calls, so the output for a case never depends on the
// cases that came before it.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
