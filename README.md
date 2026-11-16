# markdown-render-speed-02 entry

A dependency-free, single-file Markdown renderer (`parse.js`) whose
`parse(markdown)` returns exactly the HTML that **marked 18.1.3** renders
with its defaults (GFM on), written from scratch to be fast. `main.ts` is
the driver the harness runs: it reads `/input/cases.json` and writes
`/output/html.json`.

## Files

- `parse.js` — the renderer. No imports, plain JavaScript. A block parser
  (ATX and setext headings, fenced and indented code, blockquotes, lists,
  tables, HTML blocks, link reference definitions) plus an inline scanner
  (emphasis, strong and strikethrough by the CommonMark delimiter
  algorithm, links and images, code spans, autolinks including GFM
  extended autolinks, entities).
- `main.ts` — the driver: read the cases, render each one with `parse`,
  write `html.json`.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the payout wallet for this entry.

## Test

Practice set (720 cases: 680 CommonMark/GFM spec examples plus 40
generated READMEs) with the kit's CLI:

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-entry> --driver process
```

A local harness (faster iteration) lives in
`~/workspace/makefun-kits/markdown-tests/`: `test.mjs` diffs `parse.js`
against the practice `expected.json` case by case; `bench.mjs` times a
full 720-case run.

## Status

Practice score at build time: **720/720**. All 40 generated READMEs pass,
and all 680 spec examples pass, including cm-470 (`*foo __bar *baz bim__ bam*`),
a nested emphasis edge case where marked's delimiter regex skips a
`__...*...__` span at the start of its scan (reproduced by the
RDelim first-alternative skip in `firstDelimSkip`, in `parse.js`).

Speed: a full 720-case run takes roughly 450 ms locally (median), against
about 840 ms for marked itself on the same machine, so the entry is
roughly 1.9× faster than the baseline.
