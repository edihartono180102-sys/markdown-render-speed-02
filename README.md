# Make Markdown rendering faster — entry

A fast, dependency-free drop-in for `marked.parse(markdown)` (marked 18.1.3,
default options: GFM on, breaks off, pedantic off, async off). `parse.js`
exports `parse(markdown)` and returns byte-for-byte identical HTML to
marked on every case of the practice set (720/720), while running about
**1.25x faster** than marked itself (median over repeated runs of the 720
practice cases on this machine: marked ~680 ms, this entry ~535 ms).

## How it is built

`parse.js` is a bundle of the marked 18.1.3 source (vendored from the
upstream TypeScript, MIT — see `LICENSE` and `vendor/marked/{LICENSE,NOTICE}`),
with only measured, differential-tested optimizations on top. Nothing was
rewritten from scratch; every change was kept only if the 720-case
differential harness stayed at 720/720 and repeated benchmarks got faster.

Optimizations (all in the bundled source):

1. **Per-call setup removed.** The entry point calls `_Lexer.lex` and
   `_Parser.parse` directly with one shared options object and one reused
   tokenizer/renderer pair, instead of going through `marked.parse`, which
   merges options and allocates a fresh Tokenizer/Renderer on every call.
   Non-string input still throws the same error marked throws.
2. **Fast paths in the lexer.** `Lexer.lex` skips the CR normalization pass
   when the input has no `\r`. `#maskSrc` skips the backslash/code-span
   masking when there is no `\` or backtick, and skips the block masking
   when there is no backtick, `<`, or `](`.
3. **Cheaper helpers.** `decodeNumericCharacterReferences` returns early
   when there is no `&`; `cleanUrl` skips the `encodeURI` round-trip when
   the URL has no character it would change; the `[...str]` spreads in the
   tokenizer are replaced by small code-point helpers; the
   `scanLastPossibleEmStrongDelClosers` O(n) character scan is replaced by a
   `lastIndexOf`-based search for the last possible emphasis/del closer.
4. **First-character dispatch.** `#tokenizeInlines` dispatches on the first
   character of the remaining source instead of trying every inline
   tokenizer in order (e.g. `\` tries escape/br/text, `[`/`!` tries
   link/reflink/text, a word character tries url/text). The `list` item loop
   does the same for its six per-line block-start regexes and reads lines
   with `indexOf('\n')` instead of `split('\n', 1)`.

## Layout

- `parse.js` — the entry: dependency-free ES module, `parse(markdown)`.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`); reads
  `/input/cases.json`, writes `/output/html.json`.
- `LICENSE`, `vendor/marked/{LICENSE,NOTICE}` — marked's license and notice.
- `.makefun/owner.json` — the entrant's linked Solana wallet.

## Verification

- Differential harness vs the vendored marked 18.1.3 on the kit's practice
  set: **720/720 identical** (spec examples + 40 generated documents).
- Kit scorer (`program/scorer/main.ts`) on the practice set: **passed = 1**.
- Edge cases checked: empty input, CRLF, tabs, Unicode, no trailing
  newline, and the full practice set through the `main.ts` driver.
