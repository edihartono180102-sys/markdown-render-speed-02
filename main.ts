// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node main.ts` inside a fresh container. It reads the
// scored cases from /input/cases.json (a JSON array of {id, markdown}),
// renders each one on its own with parse() from ./parse.js, and writes the
// resulting HTML strings, in the same order, to /output/html.json.
// Outside the container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR let the
// same driver run against local practice directories.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
) as Case[];

const rendered: string[] = new Array<string>(cases.length);
for (let k = 0; k < cases.length; k++) {
  rendered[k] = parse(cases[k].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
