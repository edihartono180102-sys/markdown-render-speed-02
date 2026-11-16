// Driver for this entry. It reads the 720 cases, renders each one on its
// own with parse() from parse.js, and writes the HTML strings back out in
// the same order the cases came in. The harness runs it as
// `node /bot/main.ts`; outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases: Array<{ id: string; markdown: string }> = JSON.parse(raw);

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
