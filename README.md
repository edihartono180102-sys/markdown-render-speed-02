# markdown-render-speed-02 entry

A dependency-free, single-file Markdown renderer (`parse.js`) whose
`parse(markdown)` returns exactly the HTML that **marked 18.1.3** renders
with its defaults (GFM on), written from scratch to be fast. `main.ts` is
the driver the harness runs: it reads `/input/cases.json` and writes
`/output/html.json`.

## Files

- `parse.js` — the renderer. No imports, plain JavaScript. Block parser
  (ATX/setext headings, fenced and indented code, blockquotes, lists,
  tables, HTML blocks, link reference definitions) plus an inline scanner
  (emphasis/strong/strikethrough by the CommonMark delimiter algorithm,
  links and images, code spans, autolinks including GFM extended
  autolinks, entities).
- `main.ts` — driver: read cases, render each with `parse`, write html.json.
- `LICENSE` — MIT.
- `.makefun/owner.json` — payout wallet for the entry.

## Test

Practice set (720 cases: 680 CommonMark/GFM spec examples + 40 generated
READMEs) with the kit's CLI:

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-entry> --driver process
```

Local harness (faster iteration) in `~/workspace/makefun-kits/markdown-tests/`:
`test.mjs` diffs `parse.js` against the practice `expected.json` per case;
`bench.mjs` times a full 720-case run.

## Status

Practice score at build time: 684/720 (all 680 spec examples pass; 36 of
40 generated docs pass). The remaining doc diffs are edge cases in
generated READMEs (nested emphasis with a strong inside, bare-URL autolinks
containing `]`, blockquote/list continuation boundaries, tab handling in
indented code, fenced code inside list items). The gate needs 720/720, so
these still need work before the entry can be ranked.
