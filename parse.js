// A fast, dependency-free Markdown renderer matching marked 18.1.3 with its
// default settings (GFM on, breaks off, pedantic off, async off). The single
// entry point is parse(markdown), which returns exactly the HTML string that
// marked.parse(markdown) returns for the same input.
//
// Built from the CommonMark 0.31.2 and GFM 0.29 specifications and checked
// against marked's own output on hundreds of spec examples and generated
// documents. No dependencies, no network access, no clock, fully
// deterministic: the same input always produces the same output bytes.

'use strict';

// ---------------------------------------------------------------------------
// Character codes and predicates
// ---------------------------------------------------------------------------

const CH_SPACE = 32, CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_BANG = 33,
  CH_QUOTE = 34, CH_HASH = 35, CH_DOLLAR = 36, CH_PCT = 37, CH_AMP = 38,
  CH_APOS = 39, CH_LPAREN = 40, CH_RPAREN = 41, CH_STAR = 42, CH_PLUS = 43,
  CH_COMMA = 44, CH_MINUS = 45, CH_DOT = 46, CH_SLASH = 47, CH_COLON = 58,
  CH_SEMI = 59, CH_LT = 60, CH_EQ = 61, CH_GT = 62, CH_QUEST = 63, CH_AT = 64,
  CH_LBRACK = 91, CH_BSLASH = 92, CH_RBRACK = 93, CH_CARET = 94, CH_UNDER = 95,
  CH_BQUOTE = 96, CH_LBRACE = 123, CH_PIPE = 124, CH_RBRACE = 125, CH_TILDE = 126;

function isSpaceCh(c) { return c === CH_SPACE || c === CH_TAB; }

// JavaScript \s, which is what marked's whitespace regexes match: the ASCII
// whitespace characters plus the Unicode space separators.
function isWsCh(c) {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR
    || c === 0x0b || c === 0x0c || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
    || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function isDigitCh(c) { return c >= 48 && c <= 57; }
function isAlphaCh(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnumCh(c) { return isAlphaCh(c) || isDigitCh(c); }
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64)
    || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Punctuation for emphasis flanking (CommonMark): ASCII punctuation plus the
// Unicode P and S categories, so $, £ and € all count as punctuation.
const FLANK_PUNCT = /[\p{P}\p{S}]/u;
function isFlankPunctCh(c) {
  if (c < 128) return isAsciiPunct(c);
  return FLANK_PUNCT.test(String.fromCharCode(c));
}
function hexDigitVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

// Escape inline text: & < > " ' become entities, except that an & starting
// an entity-like sequence (&name; / &#123; / &#x1a;) passes through untouched,
// matching marked (named entities are left alone; numeric ones are decoded
// before escaping).
function escapeInlineText(s) {
  let out = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === CH_AMP) {
      if (!looksLikeEntity(s, i)) rep = '&amp;';
    } else if (c === CH_LT) rep = '&lt;';
    else if (c === CH_GT) rep = '&gt;';
    else if (c === CH_QUOTE) rep = '&quot;';
    else if (c === CH_APOS) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? s : out + s.slice(last);
}

// Escape code spans and code blocks: every & is escaped.
function escapeCodeText(s) {
  let out = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === CH_AMP) rep = '&amp;';
    else if (c === CH_LT) rep = '&lt;';
    else if (c === CH_GT) rep = '&gt;';
    else if (c === CH_QUOTE) rep = '&quot;';
    else if (c === CH_APOS) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? s : out + s.slice(last);
}

// Is the & at s[i] the start of an entity-like sequence?
function looksLikeEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return false;
  if (s.charCodeAt(j) === CH_HASH) {
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const st = j;
      while (j < n && hexDigitVal(s.charCodeAt(j)) >= 0) j++;
      // marked caps hex entities at 6 digits
      return j > st && j - st <= 6 && j < n && s.charCodeAt(j) === CH_SEMI;
    }
    const st = j;
    while (j < n && isDigitCh(s.charCodeAt(j))) j++;
    // marked caps decimal entities at 7 digits
    return j > st && j - st <= 7 && j < n && s.charCodeAt(j) === CH_SEMI;
  }
  const st = j;
  while (j < n && isAlnumCh(s.charCodeAt(j))) j++;
  return j > st && j < n && s.charCodeAt(j) === CH_SEMI;
}

// Decode a numeric entity starting at s[i] ('&#...;').
// Returns [decodedChar, indexAfterSemicolon] or null.
function decodeNumericRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== CH_HASH) return null;
  j++;
  let cp = 0;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    j++;
    const st = j;
    while (j < n && hexDigitVal(s.charCodeAt(j)) >= 0) {
      cp = cp * 16 + hexDigitVal(s.charCodeAt(j));
      if (cp > 0x10ffff) cp = 0x110000;
      j++;
    }
    if (j === st || j - st > 6 || j >= n || s.charCodeAt(j) !== CH_SEMI) return null;
  } else {
    const st = j;
    while (j < n && isDigitCh(s.charCodeAt(j))) {
      cp = cp * 10 + (s.charCodeAt(j) - 48);
      if (cp > 0x10ffff) cp = 0x110000;
      j++;
    }
    if (j === st || j - st > 7 || j >= n || s.charCodeAt(j) !== CH_SEMI) return null;
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// Encode a link destination the way marked does: encodeURI, then %25 -> %.
// Returns null when encodeURI throws (lone surrogate).
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tab and column helpers for source lines
// ---------------------------------------------------------------------------

// Expand the leading tabs of s into spaces (marked's expansion), starting
// the column count at startCol. Only the leading whitespace is touched.
function expandTabsAtStart(s, startCol) {
  let col = startCol, i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CH_TAB) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else if (c === CH_SPACE) {
      out += ' ';
      col++;
      i++;
    } else break;
  }
  return out + s.slice(i);
}

// Remove `cols` columns of leading indent, expanding tabs first (marked's
// list/blockquote rule: expand, then strip exactly that many columns).
function stripIndentExpanded(line, cols) {
  return expandTabsAtStart(line, 0).slice(cols);
}

// Width in columns of the leading whitespace of a line (a tab jumps to the
// next multiple of 4).
function leadingIndentWidth(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === CH_SPACE) col++;
    else if (c === CH_TAB) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `cols` columns of indent from the start of a line, tab-aware: a tab
// that straddles the boundary becomes the right number of spaces.
function stripIndentCols(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === CH_SPACE) { col++; i++; }
    else if (c === CH_TAB) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        return ' '.repeat(col + w - cols) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

// Column of the character at index idx in a line (tab-aware).
function columnOf(line, idx) {
  let col = 0;
  for (let i = 0; i < idx && i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === CH_TAB) col += 4 - (col % 4);
    else col++;
  }
  return col;
}

// Index in a line of the given column (tab-aware); line.length if past the end.
function indexOfColumn(line, col) {
  let c = 0, i = 0;
  while (i < line.length && c < col) {
    const ch = line.charCodeAt(i);
    if (ch === CH_TAB) c += 4 - (c % 4);
    else c++;
    i++;
  }
  return i;
}

// ===========================================================================
// Inline parsing
// ===========================================================================

// Normalize a link label: collapse runs of whitespace (including newlines)
// to single spaces, trim, and lowercase. ß/ẞ fold to "ss" (cm-540: [ẞ]
// matches [SS]).
function normalizeLabel(s) {
  s = s.replace(/[\u00DF\u1E9E]/g, 'ss');
  let out = '';
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWsCh(c)) {
      if (!lastSpace) { out += ' '; lastSpace = true; }
    } else {
      out += String.fromCharCode(c).toLowerCase();
      lastSpace = false;
    }
  }
  if (lastSpace && out.length > 0) out = out.slice(0, -1);
  return out;
}

// Flanking of a delimiter run at [i, i+n) in s. The characters adjacent to
// the run are taken from the source, with '\n' standing in at the boundaries,
// as cmark does.
function flanking(s, i, n) {
  const prev = i === 0 ? CH_LF : s.charCodeAt(i - 1);
  const next = i + n >= s.length ? CH_LF : s.charCodeAt(i + n);
  const prevWs = isWsCh(prev), nextWs = isWsCh(next);
  const prevPunct = isFlankPunctCh(prev), nextPunct = isFlankPunctCh(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// Parse a link destination starting at s[i] (just after '(' or after a
// reference label's colon). Returns {dest, end} with end just past the
// destination, or null.
function parseDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === CH_LT) {
    let j = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === CH_GT) return { dest: s.slice(i + 1, j), end: j + 1 };
      if (c === CH_LT || c === CH_LF || c === CH_CR) return null;
      if (c === CH_BSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) j++;
      j++;
    }
    return null;
  }
  // A bare destination: no spaces or control characters, balanced parens.
  let j = i, depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 127) break;
    if (c === CH_BSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === CH_LPAREN) depth++;
    else if (c === CH_RPAREN) {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: s.slice(i, j), end: j };
}

// Parse a link title starting at s[i] (after the destination and whitespace).
// Returns {title, end} or null. A title is "..." or '...' or (...).
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  if (q !== CH_QUOTE && q !== CH_APOS && q !== CH_LPAREN) return null;
  const close = q === CH_LPAREN ? CH_RPAREN : q;
  let j = i + 1, out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === close) return { title: out, end: j + 1 };
    if (c === CH_LF) {
      if (q === CH_LPAREN) return null;
      out += '\n'; j++;
      continue;
    }
    if (c === CH_BSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) { out += s[j + 1]; j += 2; continue; }
    out += s[j];
    j++;
  }
  return null;
}

// Advance past spaces, tabs and newlines; returns the new index.
function skipWsCh(s, i) {
  while (i < s.length && isWsCh(s.charCodeAt(i))) i++;
  return i;
}

// Parse an inline link's (destination "title") starting at s[i] == '('.
// Returns {href, title, end} or null.
function parseInlineLink(s, i, refs) {
  const n = s.length;
  let j = skipWsCh(s, i + 1);
  let href;
  if (j < n && s.charCodeAt(j) === CH_RPAREN) {
    href = ''; // empty destination: [link]()
  } else {
    const d = parseDestination(s, j);
    if (!d) return null;
    href = d.dest;
    j = skipWsCh(s, d.end);
  }
  let title = null;
  if (j < n && (s.charCodeAt(j) === CH_QUOTE || s.charCodeAt(j) === CH_APOS || s.charCodeAt(j) === CH_LPAREN)) {
    const t = parseTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = skipWsCh(s, t.end);
  }
  if (j >= n || s.charCodeAt(j) !== CH_RPAREN) return null;
  return { href: unescapeLinkText(href), title: title === null ? null : unescapeLinkText(title), end: j + 1 };
}

// Resolve backslash escapes and numeric entities in a link destination or
// title. Named entities are left alone; the renderer's smart escape passes
// them through.
function unescapeLinkText(s) {
  let out = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_BSLASH && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      if (out === null) out = '';
      // An escaped & is not an entity start.
      out += s.slice(last, i) + (s.charCodeAt(i + 1) === CH_AMP ? '&amp;' : s[i + 1]);
      i++;
      last = i + 1;
    } else if (c === CH_AMP) {
      const dec = decodeNumericRef(s, i);
      if (dec) {
        if (out === null) out = '';
        out += s.slice(last, i) + (dec[0] === '&' ? '&amp;' : dec[0]);
        i = dec[1] - 1;
        last = dec[1];
      }
    }
  }
  return out === null ? s : out + s.slice(last);
}

// Match an HTML tag, comment, processing instruction, declaration or CDATA
// section at s[i] == '<'. Returns the exclusive end index, or -1.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === CH_BANG) {
    if (s.startsWith('<!--', i)) {
      // Abruptly closed comments <!--> and <!---> are valid comments.
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    // Declaration: <! followed by a letter, up to >.
    if (i + 2 < n && isAlphaCh(s.charCodeAt(i + 2))) {
      const e = s.indexOf('>', i + 2);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (c1 === CH_QUEST) {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (c1 === CH_SLASH) {
    if (i + 2 < n && isAlphaCh(s.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && (isAlnumCh(s.charCodeAt(j)) || s.charCodeAt(j) === CH_MINUS)) j++;
      j = skipWsCh(s, j);
      if (j < n && s.charCodeAt(j) === CH_GT) return j + 1;
    }
    return -1;
  }
  if (isAlphaCh(c1)) {
    let j = i + 1;
    while (j < n && (isAlnumCh(s.charCodeAt(j)) || s.charCodeAt(j) === CH_MINUS)) j++;
    // Attributes: each must be preceded by whitespace. Whitespace skipped
    // while looking for an '=' after a boolean attribute counts as the
    // whitespace before the next attribute.
    let wsBefore = false;
    for (;;) {
      const wsStart = j;
      j = skipWsCh(s, j);
      if (j >= n) return -1;
      if (j > wsStart) wsBefore = true;
      const c = s.charCodeAt(j);
      if (c === CH_GT) return j + 1;
      if (c === CH_SLASH && j + 1 < n && s.charCodeAt(j + 1) === CH_GT) return j + 2;
      if (!wsBefore) return -1; // no whitespace before this attribute
      if (!isAlphaCh(c) && c !== CH_UNDER && c !== CH_COLON) return -1;
      while (j < n && (isAlnumCh(s.charCodeAt(j)) || s.charCodeAt(j) === CH_UNDER || s.charCodeAt(j) === CH_COLON || s.charCodeAt(j) === CH_MINUS || s.charCodeAt(j) === CH_DOT)) j++;
      wsBefore = false;
      const eqStart = j;
      j = skipWsCh(s, j);
      if (j > eqStart) wsBefore = true;
      if (j < n && s.charCodeAt(j) === CH_EQ) {
        wsBefore = false;
        j++;
        j = skipWsCh(s, j);
        if (j >= n) return -1;
        const q = s.charCodeAt(j);
        if (q === CH_QUOTE || q === CH_APOS) {
          j++;
          while (j < n && s.charCodeAt(j) !== q) j++;
          if (j >= n) return -1;
          j++;
        } else {
          const st = j;
          while (j < n) {
            const ch = s.charCodeAt(j);
            if (ch <= 32 || ch === CH_QUOTE || ch === CH_APOS || ch === CH_EQ || ch === CH_LT || ch === CH_GT || ch === CH_BQUOTE) break;
            j++;
          }
          if (j === st) return -1;
        }
      }
    }
  }
  return -1;
}

// Match an email address inside angle brackets: <local@domain.tld>.
// s[i] == '<'. Returns the exclusive end index, or -1.
function matchAngleEmail(s, i) {
  const n = s.length;
  let j = i + 1;
  const localStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnumCh(c) || c === CH_DOT || c === CH_BANG || c === CH_HASH || c === CH_DOLLAR || c === CH_PCT || c === CH_AMP || c === CH_APOS || c === CH_STAR || c === CH_PLUS || c === CH_SLASH || c === CH_EQ || c === CH_QUEST || c === CH_CARET || c === CH_UNDER || c === CH_BQUOTE || c === CH_LBRACE || c === CH_PIPE || c === CH_RBRACE || c === CH_TILDE || c === CH_MINUS) j++;
    else break;
  }
  if (j === localStart || j >= n || s.charCodeAt(j) !== CH_AT) return -1;
  j++;
  const domStart = j;
  let dots = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnumCh(c) || c === CH_MINUS) j++;
    else if (c === CH_DOT) { dots++; j++; }
    else break;
  }
  if (j === domStart || dots === 0) return -1;
  if (j >= n || s.charCodeAt(j) !== CH_GT) return -1;
  // The domain must not start or end with - or .
  const dom = s.slice(domStart, j);
  if (dom.charCodeAt(0) === CH_MINUS || dom.charCodeAt(0) === CH_DOT || dom.charCodeAt(dom.length - 1) === CH_MINUS || dom.charCodeAt(dom.length - 1) === CH_DOT) return -1;
  return j + 1;
}

// Match an angle autolink with a scheme: <scheme:...>.
// s[i] == '<'. Returns the exclusive end index, or -1.
function matchAngleScheme(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || !isAlphaCh(s.charCodeAt(j))) return -1;
  j++;
  let len = 1;
  while (j < n && len < 32) {
    const c = s.charCodeAt(j);
    if (isAlnumCh(c) || c === CH_PLUS || c === CH_MINUS || c === CH_DOT) { j++; len++; }
    else break;
  }
  // A scheme is 2-32 characters long.
  if (len < 2) return -1;
  if (j >= n || s.charCodeAt(j) !== CH_COLON) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === CH_GT) return j + 1;
    if (c === CH_SPACE || c === CH_LT || c === CH_LF) return -1;
    j++;
  }
  return -1;
}

// Trim a bare-URL autolink candidate with marked's backpedal: apply the
// regex repeatedly until the result stops changing. This trims trailing
// punctuation, unbalanced parentheses and trailing &entity; exactly the way
// marked does. (No backpedal for emails — marked does not apply it there.)
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAutolink(s, start, end) {
  let cur = s.slice(start, end), prev;
  do { prev = cur; cur = BACKPEDAL_RE.exec(cur)?.[0] ?? ''; } while (cur !== prev);
  return start + cur.length;
}

// Is c a valid email local-part character? Marked's email regex uses
// [A-Za-z0-9._+-]+ (not the broader atext set), so `*`, `~` and backtick are
// NOT local-part characters and must still act as delimiters.
function isEmailLocalChar(c) {
  return isAlnumCh(c) || c === CH_DOT || c === CH_UNDER || c === CH_PLUS || c === CH_MINUS;
}

// Is the character at text[i] part of a valid email address (local@domain)?
// Used so that _, *, ~ and ` inside an email local part are treated as text
// rather than emphasis or code delimiters (which would split the email).
function isInEmail(text, i) {
  const n = text.length;
  if (!isEmailLocalChar(text.charCodeAt(i))) return false;
  // Forward: valid local-part characters up to @.
  let j = i;
  while (j < n && isEmailLocalChar(text.charCodeAt(j))) j++;
  if (j >= n || text.charCodeAt(j) !== CH_AT) return false;
  // Domain after @.
  let k = j + 1;
  const domStart = k;
  let dots = 0;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (isAlnumCh(c) || c === CH_MINUS) k++;
    else if (c === CH_DOT) { dots++; k++; }
    else break;
  }
  let de = k;
  while (de > domStart && (text.charCodeAt(de - 1) === CH_DOT || text.charCodeAt(de - 1) === CH_MINUS)) de--;
  if (de === domStart || dots === 0) return false;
  const dom = text.slice(domStart, de);
  if (dom.charCodeAt(0) === CH_MINUS || dom.charCodeAt(0) === CH_DOT) return false;
  if (de < n) {
    const nc = text.charCodeAt(de);
    if (isAlnumCh(nc) || nc === CH_UNDER || nc === CH_MINUS) return false;
  }
  return true;
}

// Does the * or _ run starting at closerPos in fullText act as a genuine
// emphasis closer for an opener run before emailStart (so the email sits
// inside an emphasis span)? When it does, the email links in full: marked
// resolves the emphasis first and tokenizes the email inside its content,
// where the closer is absent, so the (?![\w-]) lookahead no longer truncates
// it. This covers the general case (the opener need not sit immediately
// before the email, e.g. `__cache can@x.com__`).
function emailHasEmphasisCloser(fullText, emailStart, closerPos) {
  if (!fullText || closerPos >= fullText.length) return false;
  const ch = fullText.charCodeAt(closerPos);
  if (ch !== CH_STAR && ch !== CH_UNDER) return false;
  let clLen = 0, q = closerPos;
  while (q < fullText.length && fullText.charCodeAt(q) === ch) { clLen++; q++; }
  // The run must be able to close.
  const [cLeft, cRight] = flanking(fullText, closerPos, clLen);
  let canClose;
  if (ch === CH_STAR) canClose = cRight;
  else {
    const clNext = q >= fullText.length ? CH_LF : fullText.charCodeAt(q);
    canClose = cRight && (!cLeft || isAsciiPunct(clNext));
  }
  if (!canClose) return false;
  // Scan backwards from the email start for a run of the same character
  // that can open (left-flanking; for _ the intraword rule also applies).
  let p = emailStart - 1;
  while (p >= 0) {
    if (fullText.charCodeAt(p) === ch) {
      let s = p;
      while (s >= 0 && fullText.charCodeAt(s) === ch) s--;
      const runStart = s + 1, runLen = p - s;
      const [oLeft, oRight] = flanking(fullText, runStart, runLen);
      let canOpen;
      if (ch === CH_STAR) canOpen = oLeft;
      else {
        const opPrev = runStart === 0 ? CH_LF : fullText.charCodeAt(runStart - 1);
        canOpen = oLeft && (!oRight || isAsciiPunct(opPrev));
      }
      if (canOpen) return true;
      p = s;
    } else p--;
  }
  return false;
}

// If the email at buf position i (full-text position runStart+i) is wrapped
// in an emphasis delimiter run — the opener immediately before the email, a
// closer immediately after the FULL domain end (domMax, in buf coordinates),
// equal lengths > 0, both able to open/close per flanking — return domMax
// (link the whole email). Otherwise return -1.
function emailWrapFull(s, i, domMax, n, afterChar, runStart, fullText) {
  if (!fullText || runStart === undefined) return -1;
  const emailStart = runStart + i;
  const domEnd = runStart + domMax;
  if (emailStart <= 0 || domEnd >= fullText.length + 1) return -1;
  const opCh = fullText.charCodeAt(emailStart - 1);
  if (opCh !== CH_STAR && opCh !== CH_UNDER) return -1;
  let opLen = 0, p = emailStart - 1;
  while (p >= 0 && fullText.charCodeAt(p) === opCh) { opLen++; p--; }
  let clLen = 0, q = domEnd;
  while (q < fullText.length && fullText.charCodeAt(q) === opCh) { clLen++; q++; }
  if (opLen === 0 || clLen !== opLen) return -1;
  const [oLeft, oRight] = flanking(fullText, emailStart - opLen, opLen);
  const [cLeft, cRight] = flanking(fullText, domEnd, clLen);
  let canOpen, canClose;
  if (opCh === CH_STAR) { canOpen = oLeft; canClose = cRight; }
  else {
    const opPrev = emailStart - opLen === 0 ? CH_LF : fullText.charCodeAt(emailStart - opLen - 1);
    const clNext = domEnd + clLen >= fullText.length ? CH_LF : fullText.charCodeAt(domEnd + clLen);
    canOpen = oLeft && (!oRight || isAsciiPunct(opPrev));
    canClose = cRight && (!cLeft || isAsciiPunct(clNext));
  }
  if (!canOpen || !canClose) return -1;
  return domMax;
}

// Try to match a GFM extended autolink at s[i]. prevOk is not used here;
// afterChar is the character after the run in the full text (-1 if none),
// used for the email lookahead. runStart/fullText locate this run in the
// full paragraph text (for the emphasis-wrap exception).
// Returns {href, text, start, end} or null.
function matchExtendedAutolink(s, i, afterChar, runStart, fullText) {
  const n = s.length;
  // www. links
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    if (j >= n || !(isAlnumCh(s.charCodeAt(j)) || s.charCodeAt(j) === CH_MINUS)) return null;
    let dots = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isAlnumCh(c) || c === CH_MINUS || c === CH_DOT || c === CH_UNDER) { if (c === CH_DOT) dots++; j++; }
      else break;
    }
    if (dots === 0) return null;
    // Path: /... (no spaces, no < >).
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === CH_LT || c === CH_GT) break;
      j++;
    }
    const e = trimAutolink(s, i, j);
    if (e === i) return null;
    const text = s.slice(i, e);
    return { href: 'http://' + text, text, start: i, end: e };
  }
  // scheme:// links
  const m = /^(https?|ftp):\/\//i.exec(s.slice(i, i + 8));
  if (m) {
    let j = i + m[0].length;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === CH_LT || c === CH_GT) break;
      j++;
    }
    const e = trimAutolink(s, i, j);
    if (e === i) return null;
    const text = s.slice(i, e);
    return { href: text, text, start: i, end: e };
  }
  // Email addresses: local@domain.tld — the local part is marked's
  // [A-Za-z0-9._+-]+ (not the broader atext set: `*` and friends must not
  // swallow a preceding emphasis run, e.g. `**because@x.com**` links
  // `because@x.com`).
  let j = i;
  const localStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnumCh(c) || c === CH_DOT || c === CH_UNDER || c === CH_PLUS || c === CH_MINUS) j++;
    else break;
  }
  if (j > localStart && j < n && s.charCodeAt(j) === CH_AT) {
    const at = j;
    j++;
    const domStart = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isAlnumCh(c) || c === CH_MINUS || c === CH_DOT) j++;
      else break;
    }
    const domMax = j;
    // Backtrack: the domain is the LONGEST prefix ending in an alnum, with
    // at least one dot, not starting with - or ., followed by a character
    // not in [\w-] (marked's email regex backtracks: `because@mark.example
    // .com__` links `because@mark.example`).
    let de = -1;
    for (let k = domMax; k > domStart; k--) {
      if (!isAlnumCh(s.charCodeAt(k - 1))) continue;
      const dom = s.slice(domStart, k);
      if (dom.indexOf('.') === -1) continue;
      if (dom.charCodeAt(0) === CH_MINUS || dom.charCodeAt(0) === CH_DOT) continue;
      const nc = k < n ? s.charCodeAt(k) : afterChar;
      if (nc !== -1 && (isAlnumCh(nc) || nc === CH_UNDER || nc === CH_MINUS)) continue;
      de = k;
      break;
    }
    // Emphasis-wrap exception: if the email is wrapped in an emphasis run,
    // it links in full even though the character after the domain is _ or *.
    if ((de === -1 || de < domMax) && emailWrapFull(s, i, domMax, n, afterChar, runStart, fullText) !== -1) de = domMax;
    // General emphasis exception: the domain is followed by a * or _ run
    // that is a real closer for an opener before the email (the email sits
    // inside an emphasis span, e.g. `__cache can@x.com__`).
    if ((de === -1 || de < domMax) && fullText !== undefined && runStart !== undefined) {
      const closerPos = runStart + domMax;
      if (emailHasEmphasisCloser(fullText, runStart + i, closerPos)) de = domMax;
    }
    if (de !== -1) {
      let linkStart = i, hrefPrefix = 'mailto:';
      // mailto: / xmpp: plus an email links the whole thing including the scheme.
      if (i >= 7 && s.slice(i - 7, i).toLowerCase() === 'mailto:') { linkStart = i - 7; hrefPrefix = ''; }
      else if (i >= 5 && s.slice(i - 5, i).toLowerCase() === 'xmpp:') { linkStart = i - 5; hrefPrefix = ''; }
      let end = de;
      let text = s.slice(linkStart, end);
      // xmpp: may include one /segment of [A-Za-z0-9@.]+ after the email.
      if (hrefPrefix === '' && s.slice(linkStart, linkStart + 5).toLowerCase() === 'xmpp:' && end < n && s.charCodeAt(end) === CH_SLASH) {
        let k = end + 1;
        while (k < n) {
          const c = s.charCodeAt(k);
          if (isAlnumCh(c) || c === CH_AT || c === CH_DOT) k++;
          else break;
        }
        if (k > end + 1) { end = k; text = s.slice(linkStart, end); }
      }
      return { href: hrefPrefix + text, text, start: linkStart, end };
    }
  }
  return null;
}

// Lexer-global inline state (marked's inLink / inRawBlock): set by inline
// HTML tags (<a>, <pre>/<code>/<kbd>/<script>) and reset per parse() call.
// While inLink, extended autolinks are suppressed; while inRawBlock, numeric
// entities are not decoded and text is emitted raw.
let _IN_LINK = false, _IN_RAW = false;
const START_A_TAG = /^<a /i, END_A_TAG = /^<\/a>/i;
const START_RAW_TAG = /^<(pre|code|kbd|script)(\s|>)/i, END_RAW_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
function updateInlineState(tag) {
  if (!_IN_LINK && START_A_TAG.test(tag)) _IN_LINK = true;
  else if (_IN_LINK && END_A_TAG.test(tag)) _IN_LINK = false;
  if (!_IN_RAW && START_RAW_TAG.test(tag)) _IN_RAW = true;
  else if (_IN_RAW && END_RAW_TAG.test(tag)) _IN_RAW = false;
}

// ---------------------------------------------------------------------------
// Inline node kinds
// ---------------------------------------------------------------------------
// 0 text {s} | 1 code {s} | 2 delim {ch,n,open,close} | 3 link {href,title,kids}
// 4 image {src,title,alt} | 5 html {s} | 6 br | 7 opener {image,dead,srcPos}
// 8 emphasis {type,kids} (type: 'em' | 'strong' | 'del')

const SPECIAL_CHARS = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 60, 38, 126, 10, 33]) SPECIAL_CHARS[c] = 1;

// Does a link (inline or reference) form at the ']' at text[j] for any
// pending opener? A pure check with no mutation — it mirrors tryLink's
// "formed" logic. It exists to give links precedence over code spans: in
// marked the link tokenizer runs before codespan, so a code span must not
// span across the ']' of a link that will form (e.g. `[docs each ``url`](…)`
// followed by `` `` a ` b `` `` on a later line must keep the link rather
// than forming a code span from the `` `` `` before `url` to the later one).
function linkFormsAt(text, j, openers, refs) {
  for (let oi = 0; oi < openers.length; oi++) {
    const op = openers[oi];
    if (op.dead) continue;
    const textStart = op.srcPos + (op.image ? 2 : 1);
    if (textStart > j) continue;
    if (!isBalancedLabel(text, textStart, j)) continue;
    const next = j + 1 < text.length ? text.charCodeAt(j + 1) : -1;
    if (next === CH_LPAREN) {
      if (parseInlineLink(text, j + 1, refs)) return true;
      const label = normalizeLabel(text.slice(textStart, j));
      if (label !== '' && label.length <= 999 && refs.get(label)) return true;
    } else if (next === CH_LBRACK) {
      let k = j + 2, depth = 0, ok = false, labelEnd = -1;
      while (k < text.length) {
        const cc = text.charCodeAt(k);
        if (cc === CH_BSLASH && k + 1 < text.length) { k += 2; continue; }
        if (cc === CH_LBRACK) depth++;
        else if (cc === CH_RBRACK) { if (depth === 0) { labelEnd = k; ok = true; break; } depth--; }
        k++;
      }
      if (ok) {
        let label;
        if (labelEnd === j + 2) label = normalizeLabel(text.slice(textStart, j));
        else label = normalizeLabel(text.slice(j + 2, labelEnd));
        if (label !== '' && label.length <= 999 && refs.get(label)) return true;
      }
    } else {
      const label = normalizeLabel(text.slice(textStart, j));
      if (label !== '' && label.length <= 999 && refs.get(label)) return true;
    }
  }
  return false;
}

// Would a code span whose content runs from r to closePos break a link that
// will form? True when some unescaped ']' inside (r, closePos) closes a
// pending opener's label and a link forms there.
function codeSpanBreaksLink(text, r, closePos, openers, refs) {
  if (!openers.length) return false;
  let j = text.indexOf(']', r);
  while (j !== -1 && j < closePos) {
    let b = j - 1, bs = 0;
    while (b >= 0 && text.charCodeAt(b) === CH_BSLASH) { bs++; b--; }
    if (bs % 2 === 0 && linkFormsAt(text, j, openers, refs)) return true;
    j = text.indexOf(']', j + 1);
  }
  return false;
}

// Is the source text s[start..end) balanced in brackets (depth never goes
// negative and ends at 0), skipping escaped characters and code spans?
function isBalancedLabel(s, start, end) {
  let depth = 0;
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === CH_BSLASH && i + 1 < end) { i += 2; continue; }
    if (c === CH_BQUOTE) {
      let r = i;
      while (r < end && s.charCodeAt(r) === CH_BQUOTE) r++;
      const run = r - i;
      // A code span in a link label is lenient: its closer run may be ANY
      // length (`` ``url` `` counts as a span for balancing). Find the
      // first later backtick run.
      let j = r, close = -1;
      while (j < end) {
        if (s.charCodeAt(j) === CH_BQUOTE) { close = j; break; }
        j++;
      }
      if (close === -1) {
        // No closer: literal only when the run is 2+ backticks immediately
        // before ']' — including when the run ends the label, so the ']'
        // is the one tryLink was called at (r === end). Otherwise the
        // label is invalid and no link forms.
        if (run >= 2 && (r === end || s.charCodeAt(r) === CH_RBRACK)) { i = r; continue; }
        return false;
      }
      let k = close;
      while (k < end && s.charCodeAt(k) === CH_BQUOTE) k++;
      i = k;
      continue;
    }
    if (c === CH_LBRACK) depth++;
    else if (c === CH_RBRACK) {
      depth--;
      if (depth < 0) return false;
    }
    i++;
  }
  return depth === 0;
}

// Do these inline nodes contain a real (non-autolink) link node? Autolinks
// demote to plain text inside link text and do not block it.
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 3 && !nd.auto) return true;
    if (nd.kids && containsLink(nd.kids)) return true;
  }
  return false;
}

// Demote autolink nodes to plain text (in place, recursively). Extended
// autolinks (bare URLs and emails) demote; angle autolinks (<...>) stay as
// nested links inside link text (marked keeps them).
function demoteAutoLinks(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.t === 3 && nd.auto && !nd.angle) {
      nodes[i] = { t: 0, s: nd.kids && nd.kids[0] ? nd.kids[0].s : '' };
    } else if (nd.kids) {
      demoteAutoLinks(nd.kids);
    }
  }
}

// Try to form a link or image at the ']' at s[j]. Openers are tried from
// OUTERMOST to INNERMOST; the first opener whose text (between the opener
// and this ']') is balanced is the candidate. If a link forms but its text
// contains a link, it never forms and no other opener is tried. When the
// link does not parse, the next opener is tried. An inline link that fails
// to parse falls back to the shortcut reference.
function tryLink(s, j, nodes, openers, refs) {
  for (let oi = 0; oi < openers.length; oi++) {
    const op = openers[oi];
    if (op.dead) continue;
    const opIdx = nodes.indexOf(op.node);
    if (opIdx < 0) continue;
    const textStart = op.srcPos + (op.image ? 2 : 1);
    if (!isBalancedLabel(s, textStart, j)) continue;
    const isImage = op.image;
    const next = j + 1 < s.length ? s.charCodeAt(j + 1) : -1;
    let href = null, title = null, end = -1, formed = false;
    if (next === CH_LPAREN) {
      const r = parseInlineLink(s, j + 1, refs);
      if (r) {
        href = r.href; title = r.title; end = r.end; formed = true;
      } else {
        // Fall back to the shortcut reference (cm-568).
        const label = normalizeLabel(s.slice(textStart, j));
        if (label !== '' && label.length <= 999) {
          const ref = refs.get(label);
          if (ref) { href = ref.href; title = ref.title; end = j + 1; formed = true; }
        }
      }
    } else if (next === CH_LBRACK) {
      // [label] or [] (collapsed reference)
      let k = j + 2, depth = 0, ok = false;
      let labelEnd = -1;
      while (k < s.length) {
        const c = s.charCodeAt(k);
        if (c === CH_BSLASH && k + 1 < s.length) { k += 2; continue; }
        if (c === CH_LBRACK) depth++;
        else if (c === CH_RBRACK) {
          if (depth === 0) { labelEnd = k; ok = true; break; }
          depth--;
        }
        k++;
      }
      if (ok) {
        let label;
        if (labelEnd === j + 2) {
          // Collapsed: the label is the link text.
          label = normalizeLabel(s.slice(textStart, j));
        } else {
          label = normalizeLabel(s.slice(j + 2, labelEnd));
        }
        if (label !== '' && label.length <= 999) {
          const ref = refs.get(label);
          if (ref) { href = ref.href; title = ref.title; end = labelEnd + 1; formed = true; }
        }
      }
    } else {
      // Shortcut reference: the label is the link text.
      const label = normalizeLabel(s.slice(textStart, j));
      if (label !== '' && label.length <= 999) {
        const ref = refs.get(label);
        if (ref) { href = ref.href; title = ref.title; end = j + 1; formed = true; }
      }
    }
    if (!formed) continue; // try the next opener
    // A link whose text contains a real link never forms (and no other
    // opener is tried). Autolinks demote to plain text inside link text.
    if (!isImage && containsLink(nodes.slice(opIdx + 1))) return -1;
    // Form the link: the children are the nodes after the opener up to now.
    const kids = nodes.splice(opIdx + 1);
    // Delimiters inside the label were created dead (masking); a link that
    // forms re-tokenises its label unmasked, so revive them.
    for (const kd of kids) if (kd.t === 2) kd.dead = false;
    demoteAutoLinks(kids);
    // Mark inner openers dead.
    for (let k = oi + 1; k < openers.length; k++) openers[k].dead = true;
    openers.splice(oi, 1);
    nodes.splice(opIdx, 1); // remove the opener node
    if (isImage) {
      // Resolve emphasis in the description before computing the alt text,
      // so e.g. ![foo *bar*] has alt "foo bar".
      resolveDelims(kids);
      const alt = plainText(kids);
      nodes.push({ t: 4, src: href, title, alt });
    } else {
      nodes.push({ t: 3, href, title, kids });
    }
    return end;
  }
  return -1;
}

// The plain-text content of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0 || nd.t === 1 || nd.t === 5) out += nd.s;
    else if (nd.t === 2) out += nd.ch.repeat(nd.n);
    else if (nd.t === 3 || nd.t === 8) out += plainText(nd.kids);
    else if (nd.t === 4) out += nd.alt;
    else if (nd.t === 7) out += nd.image ? '![' : '[';
  }
  return out;
}

// Classify a delimiter run into marked's RDelim groups 1-6 from its
// surrounding characters (pc/nc, stored at creation).
//   1: punctuation before, space/end after (plain closer)
//   2: alnum before, punctuation/space/end after (plain closer)
//   3: punctuation/space before, alnum after (opener-like)
//   4: space before, punctuation after (opener-like)
//   5: punctuation before, punctuation after (ambiguous: both)
//   6: alnum before, alnum after (ambiguous: both; not a group for `_`)
// Returns 0 when the run cannot participate (intraword `_`).
function delimGroup(nd) {
  const pc = nd.pc, nc = nd.nc;
  const pcWs = pc === -1 || isWsCh(pc);
  const ncWs = nc === -1 || isWsCh(nc);
  // marked's RDelim "punct" is Unicode [\p{P}\p{S}] (so £ and € count).
  const pcPu = pc !== -1 && isFlankPunctCh(pc);
  const ncPu = nc !== -1 && isFlankPunctCh(nc);
  const pcAl = !pcWs && !pcPu;
  const ncAl = !ncWs && !ncPu;
  if (nd.ch === '_' && pcAl && ncAl) return 0;
  if (pcPu && ncWs) return 1;
  if (pcAl && (ncPu || ncWs)) return 2;
  if ((pcPu || pcWs) && ncAl) return 3;
  if (pcWs && ncPu) return 4;
  if (pcPu && ncPu) return 5;
  if (pcAl && ncAl) return 6;
  return 0;
}

// Marked's emStrong RDelim first-alternative skip (cm-470).
//
// When marked scans for a closer, its RDelim regex (emStrongRDelimAst for
// `*`, emStrongRDelimUnd for `_`) starts with a no-capture alternative:
//   ^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)   (for `*`; the `_` one is mirrored:
//   ^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*))
// A match of that alternative consumes the whole `__...*...__` span
// without capturing a delimiter, so the inner `*` never counts toward the
// opener's m/f totals and the outer `*` can close past it:
// `*foo __bar *baz bim__ bam*` -> `<em>foo <strong>bar *baz bim</strong> bam</em>`.
// Three properties of that regex bound the skip, and all three matter — a
// looser "skip any delimiter inside __...__" over-fires on unrelated `**`
// runs in long paragraphs:
//   1. The `^` anchor (no /m flag) means the alternative can only match on
//      the scan's first exec, i.e. only for the FIRST delimiter of the
//      scanned character after the opener.
//   2. The `[^_*]` parts forbid any other `*` or `_` between the pieces:
//      the opposite pair must be the first delimiter of its character
//      after the opener and must precede the skipped run, no delimiter of
//      either character may sit between the pair and the run, and the
//      first delimiter after the run must be the closing pair.
//   3. The single `\*` (resp. `_`) means the skipped run is exactly one
//      delimiter: a `**` run is never skipped (the second `*` blocks the
//      `[^_*]*?` before the `(?=__)` lookahead), and the opening pair is
//      exactly two (`___` cannot open it: after matching the first two
//      underscores the third blocks `[^_*]*?`). The closing pair needs
//      two or more (a lookahead only).
// Del's RDelim has no such alternative, so `~` never skips.
// Only live (non-dead) delimiter nodes are considered: a dead node sits
// inside a masked code span or link label, which marked's masked source
// replaces, so it is invisible to the `[^_*]` parts too.
// Returns the node index to skip, or -1.
function firstDelimSkip(nodes, oi, ch) {
  const other = ch === '*' ? '_' : '*';
  let firstCh = -1, firstOther = -1, secondOther = -1;
  for (let k = oi + 1; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t !== 2 || nd.dead || nd.n === 0) continue;
    if (nd.ch === ch) { if (firstCh < 0) firstCh = k; }
    else if (nd.ch === other) {
      if (firstOther < 0) firstOther = k;
      else if (secondOther < 0) secondOther = k;
    }
  }
  if (firstCh < 0 || firstOther < 0) return -1;
  if (firstOther > firstCh) return -1;          // pair must precede the run
  if (nodes[firstOther].n !== 2) return -1;     // opening pair is exactly two
  if (nodes[firstCh].n !== 1) return -1;        // skipped run is exactly one
  if (secondOther >= 0 && secondOther < firstCh) return -1; // nothing between pair and run
  // The first live delimiter after the run must be the closing pair.
  for (let k = firstCh + 1; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t !== 2 || nd.dead || nd.n === 0) continue;
    if (nd.ch !== other) return -1;
    return nd.n >= 2 ? firstCh : -1;
  }
  return -1;
}

// Find the closer for the opener at index oi, using marked's emStrong/del
// scan (m/f counting for * and _, p-counting for ~). Marked retries
// emStrong at each delimiter of a run, so a run longer than its closer
// still forms emphasis from a later delimiter of the run (`**foo*` ->
// `*<em>foo</em>`): the full opener length is tried first, then
// progressively shorter lengths. Returns {ci, use, type, tryN} or null,
// where tryN is the opener length that matched.
function findDelimCloser(nodes, oi, opener) {
  const ch = opener.ch;
  if (ch === '~') return scanDelimCloser(nodes, oi, opener, opener.n);
  for (let tryN = opener.n; tryN >= 1; tryN--) {
    const found = scanDelimCloser(nodes, oi, opener, tryN);
    if (found) return { ...found, tryN };
  }
  return null;
}

function scanDelimCloser(nodes, oi, opener, tryN) {
  const ch = opener.ch;
  const chCode = ch.charCodeAt(0);
  // R: the opener run could itself act as a closer, so the rule of 3
  // applies to plain closers too. o: the character before the opener is
  // the delimiter character (false for maximal runs).
  const pc = opener.pc, nc = opener.nc;
  const pcWs = pc === -1 || isWsCh(pc);
  const R = !pcWs && (nc !== -1 || (ch === '*' && !isAsciiPunct(pc)));
  const o = pc === chCode;
  const y = tryN; // rule-of-3 base: the opener run length being tried
  if (ch === '~') {
    // del: p-counting; the closer must have exactly the opener's length.
    let p = tryN;
    for (let ci = oi + 1; ci < nodes.length; ci++) {
      const nd = nodes[ci];
      if (nd.t !== 2 || nd.ch !== '~' || nd.dead || nd.n === 0) continue;
      if (nd.n !== tryN) continue;
      const g = delimGroup(nd);
      if (g === 0) continue;
      if (g === 3 || g === 4) { p += nd.n; continue; }
      p -= nd.n;
      if (p > 0) continue;
      const use = Math.min(nd.n, nd.n + p);
      return { ci, use, type: 'del' };
    }
    return null;
  }
  // em/strong: m/f counting. The RDelim first-alternative skip (see
  // firstDelimSkip) hides one delimiter from this scan.
  const skipIdx = firstDelimSkip(nodes, oi, ch);
  let m = tryN;
  let f = 0;
  for (let ci = oi + 1; ci < nodes.length; ci++) {
    const nd = nodes[ci];
    if (nd.t !== 2 || nd.ch !== ch || nd.dead || nd.n === 0) continue;
    if (ci === skipIdx) continue;
    const g = delimGroup(nd);
    if (g === 0) continue;
    const b = nd.n;
    if (g === 3 || g === 4) { m += b; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const use = Math.min(b, b + m + f);
    const type = Math.min(tryN, use) % 2 === 1 ? 'em' : 'strong';
    return { ci, use, type };
  }
  return null;
}

// Flanking computed from the surrounding characters (pc/nc, -1 = text
// boundary), mirroring flanking() — a boundary counts as whitespace, not
// punctuation.
function flankFromEnds(pc, nc) {
  const prev = pc === -1 ? CH_LF : pc;
  const next = nc === -1 ? CH_LF : nc;
  const prevWs = isWsCh(prev), nextWs = isWsCh(next);
  const prevPunct = isFlankPunctCh(prev), nextPunct = isFlankPunctCh(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// A leftover delimiter node: `count` delimiters of src's character, at a
// new position with the given surrounding characters (pc/nc); flanking is
// recomputed for that position.
function makeLeftoverDelim(src, count, pc, nc) {
  const ch = src.ch;
  const [left, right] = flankFromEnds(pc, nc);
  let open, close;
  if (ch === '*') { open = left; close = right; }
  else if (ch === '_') {
    open = left && (!right || isFlankPunctCh(pc === -1 ? CH_LF : pc));
    close = right && (!left || isFlankPunctCh(nc === -1 ? CH_LF : nc));
  } else { open = left; close = right; }
  return { t: 2, ch, n: count, open, close, dead: false, pc, nc, orig: count };
}

// Resolve emphasis and strikethrough delimiters in one node list
// (recursive: link children resolve within the link).
function resolveDelims(nodes) {
  for (const nd of nodes) {
    if (nd.t === 3) resolveDelims(nd.kids);
  }
  // Opener-forward scan (marked's emStrong/del): for each opener in order,
  // scan forward for its closer; on a match, wrap, recursively resolve the
  // children, and continue after the span.
  let oi = 0;
  while (oi < nodes.length) {
    const opener = nodes[oi];
    if (opener.t !== 2 || opener.dead || opener.n === 0 || !opener.open) { oi++; continue; }
    const found = findDelimCloser(nodes, oi, opener);
    if (!found) { oi++; continue; }
    const closer = nodes[found.ci];
    const tryN = found.tryN !== undefined ? found.tryN : opener.n;
    const k = tryN;            // effective opener run length (may be < opener.n)
    const bRun = closer.n;     // closer run length
    const use = found.use;     // closer delimiters consumed by the match
    // Delimiters that form the node: 1 for em, 2 for strong, the whole run
    // for del. The rest stay inside the node's content (marked's text
    // retains them: the opener's leftover at the start, the closer's
    // leftover (use - delimUse) at the end); the closer run's remainder
    // (bRun - use) stays after the node. When the match used a shorter
    // opener than the run (tryN < opener.n), the extra opener delimiters
    // are literal text before the node.
    const delimUse = found.type === 'del' ? k : (found.type === 'em' ? 1 : 2);
    const kids = nodes.slice(oi + 1, found.ci);
    const openLeft = k - delimUse;
    if (openLeft > 0) kids.unshift(makeLeftoverDelim(opener, openLeft, -1, opener.nc));
    const closeInside = use - delimUse;
    if (closeInside > 0) kids.push(makeLeftoverDelim(closer, closeInside, closer.pc, -1));
    const emNode = { t: 8, type: found.type, kids };
    const replacement = [];
    const outsideLeft = opener.n - tryN;
    if (outsideLeft > 0) replacement.push({ t: 0, s: opener.ch.repeat(outsideLeft) });
    replacement.push(emNode);
    const closeOutside = bRun - use;
    if (closeOutside > 0) replacement.push(makeLeftoverDelim(closer, closeOutside, closer.pc, closer.nc));
    nodes.splice(oi, found.ci - oi + 1, ...replacement);
    // Recursively resolve nested emphasis inside the new node.
    resolveDelims(emNode.kids);
    // Continue after the new node (a leftover closer after it is
    // re-examined as a possible opener).
    oi = oi + (outsideLeft > 0 ? 1 : 0) + 1;
  }
}

// Render inline nodes to HTML.
function renderInline(nodes, out) {
  for (const nd of nodes) {
    switch (nd.t) {
      case 0: if (nd.raw) out.push(nd.s); else out.push(escapeInlineText(nd.s)); break;
      case 1: out.push('<code>' + escapeCodeText(nd.s) + '</code>'); break;
      case 2: out.push(nd.ch.repeat(nd.n)); break;
      case 3: {
        const href = cleanHref(nd.href);
        if (href === null) { renderInline(nd.kids, out); break; }
        out.push('<a href="' + escapeInlineText(href) + '"');
        if (nd.title !== null && nd.title !== undefined) out.push(' title="' + escapeInlineText(nd.title) + '"');
        out.push('>');
        renderInline(nd.kids, out);
        out.push('</a>');
        break;
      }
      case 4: {
        const src = cleanHref(nd.src);
        if (src === null) break;
        out.push('<img src="' + escapeInlineText(src) + '" alt="' + escapeInlineText(nd.alt) + '"');
        if (nd.title !== null && nd.title !== undefined) out.push(' title="' + escapeInlineText(nd.title) + '"');
        out.push('>');
        break;
      }
      case 5: out.push(nd.s); break;
      case 6: out.push('<br>'); break;
      case 7: out.push(nd.image ? '![' : '['); break;
      case 8:
        if (nd.type === 'del') out.push('<del>');
        else if (nd.type === 'strong') out.push('<strong>');
        else out.push('<em>');
        renderInline(nd.kids, out);
        if (nd.type === 'del') out.push('</del>');
        else if (nd.type === 'strong') out.push('</strong>');
        else out.push('</em>');
        break;
    }
  }
}

// Flush an accumulated text run into nodes, splitting out extended
// autolinks. prevChar is the character code immediately before s[0] in the
// source (-1 = start of the text).
function flushText(s, nodes, prevChar, fullText, runStart) {
  const end = s.length;
  if (end === 0) return;
  // While inside <a>…</a>, extended autolinks are suppressed (marked's
  // inLink): the run is plain text.
  if (_IN_LINK) { nodes.push({ t: 0, s, raw: _IN_RAW }); return; }
  // The character after this run in the full text (for the email lookahead).
  const afterChar = fullText !== undefined && runStart + end < fullText.length ? fullText.charCodeAt(runStart + end) : -1;
  // Fast path: no autolink candidates in this run.
  if (s.indexOf('www.') === -1 && s.indexOf('://') === -1 && s.indexOf('@') === -1) {
    nodes.push({ t: 0, s, raw: _IN_RAW });
    return;
  }
  // Careful path: scan for autolink starts.
  let i = 0;
  let segStart = 0;
  while (i < end) {
    const pc = i === 0 ? prevChar : s.charCodeAt(i - 1);
    const prevOk = pc === -1 || isWsCh(pc) || pc === CH_LPAREN || pc === CH_STAR || pc === CH_UNDER || pc === CH_TILDE;
    // scheme:// links regardless of the preceding character (cm-602); www.
    // and email need prevOk. mailto:/xmpp: plus an email also links (the :
    // is not in prevOk, so the scheme prefix is checked explicitly).
    const isScheme = (s.charCodeAt(i) === 104 || s.charCodeAt(i) === 72 || s.charCodeAt(i) === 102 || s.charCodeAt(i) === 70) &&
      /^(?:https?|ftp):\/\//i.test(s.slice(i, i + 8));
    let m = null;
    if (prevOk || isScheme) m = matchExtendedAutolink(s, i, afterChar, runStart, fullText);
    else if (i > 0 && s.charCodeAt(i - 1) === CH_COLON) {
      const before = s.slice(0, i).toLowerCase();
      if (before.endsWith('mailto:') || before.endsWith('xmpp:')) m = matchExtendedAutolink(s, i, afterChar, runStart, fullText);
    }
    if (m) {
      const ls = m.start !== undefined ? m.start : i;
      if (ls > segStart) nodes.push({ t: 0, s: s.slice(segStart, ls), raw: _IN_RAW });
      // Mark it as an autolink: inside link text it demotes to plain text.
      // Autolink children are NOT raw (they are link text, not raw-block text).
      nodes.push({ t: 3, href: m.href, title: null, kids: [{ t: 0, s: m.text }], auto: true });
      i = m.end;
      segStart = i;
    } else {
      i++;
    }
  }
  if (segStart < end) nodes.push({ t: 0, s: s.slice(segStart, end), raw: _IN_RAW });
}

// Does buf end with a bare www. or scheme URL (no space or < after its
// start)? If so, a following backslash is part of the URL (marked's url
// regex consumes it: `www.flux.com\` + newline links `www.flux.com\`), not
// a hard break. fullText/bufStart give the character before the run.
function bufEndsWithUrl(buf, bufStart, fullText) {
  const n = buf.length;
  if (n === 0) return false;
  // The maximal run of non-space, non-< characters ending at the end of buf.
  let p = n;
  while (p > 0) {
    const c = buf.charCodeAt(p - 1);
    if (c <= 32 || c === CH_LT) break;
    p--;
  }
  if (p === n) return false;
  // Within the run, find the FIRST www./scheme start: the URL is the
  // suffix of the run from its start (`https://www.…` starts at the
  // scheme, not at the `www.` inside it).
  let start = -1;
  const w = buf.indexOf('www.', p);
  if (w !== -1 && w < n) start = w;
  let j = buf.indexOf('://', p);
  while (j !== -1 && j < n) {
    for (let s = Math.max(p, j - 5); s < j; s++) {
      if (/^(?:https?|ftp):\/\//i.test(buf.slice(s, j + 3))) { if (start === -1 || s < start) start = s; break; }
    }
    j = buf.indexOf('://', j + 1);
  }
  if (start === -1) return false;
  const tail = buf.slice(start);
  const isScheme = /^(?:https?|ftp):\/\//i.test(tail);
  if (tail.startsWith('www.') && tail.indexOf('.', 4) === -1) return false;
  if (isScheme && tail.length <= 8) return false;
  const pc = start === 0 ? (bufStart > 0 ? fullText.charCodeAt(bufStart - 1) : -1) : buf.charCodeAt(start - 1);
  const prevOk = pc === -1 || isWsCh(pc) || pc === CH_LPAREN || pc === CH_STAR || pc === CH_UNDER || pc === CH_TILDE;
  if (!prevOk && !isScheme) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Emphasis masking (marked's #n)
// ---------------------------------------------------------------------------
// Marked masks link labels, code spans and HTML tags out of the text it
// uses for emphasis resolution: delimiters inside those regions are
// invisible to emStrong/del (they cannot open or close). The pipeline is
// order-dependent: Ot normalises code spans (inner backticks become '+'),
// which lets blockSkip's link/code-span alternatives span across them.
// Both regexes are length-preserving, so match ranges map 1:1 onto the
// original text. (Generated from marked 18.1.3's rules — verbatim sources.)
const OT_MASK_RE = new RegExp("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", 'gu');
const BLOCKSKIP_RE = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", 'g');

// Ranges [start, end) of the text where emphasis delimiters are invisible
// (inside a blockSkip match: a [...](...) link, a code span, or an HTML
// tag). Returns [] when the text cannot contain a match.
function computeMaskedRanges(s) {
  if (s.indexOf('[') === -1 && s.indexOf('`') === -1 && s.indexOf('<') === -1) return [];
  const ot = s.replace(OT_MASK_RE, (n, p1, p2) => p2 ? '+'.repeat(n.length) : p1 ? p1 + n.slice(p1.length, -p1.length).replace(/`/g, '+') + p1 : n);
  const ranges = [];
  BLOCKSKIP_RE.lastIndex = 0;
  let m;
  while ((m = BLOCKSKIP_RE.exec(ot)) !== null) {
    if (m[0].length === 0) { BLOCKSKIP_RE.lastIndex++; continue; }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
function isMaskedPos(ranges, pos) {
  for (let k = 0; k < ranges.length; k++) {
    if (pos >= ranges[k][0] && pos < ranges[k][1]) return true;
    if (ranges[k][0] > pos) break;
  }
  return false;
}

// The main inline parser: source text -> HTML string.
function parseInline(text, refs) {
  const n = text.length;
  const nodes = [];
  const openers = [];
  // Ranges where emphasis delimiters are invisible (marked's #n masking:
  // Ot-normalised code spans plus blockSkip link/code-span/HTML matches).
  // A delimiter inside such a range is created dead; it is revived if it
  // lands inside a link that forms (the label is re-tokenised unmasked).
  const maskedRanges = (text.indexOf('*') !== -1 || text.indexOf('_') !== -1 || text.indexOf('~') !== -1)
    ? computeMaskedRanges(text) : [];
  let buf = '';
  let bufStart = 0; // source position of buf[0]
  const flushBuf = () => {
    if (buf) {
      flushText(buf, nodes, bufStart > 0 ? text.charCodeAt(bufStart - 1) : -1, text, bufStart);
      buf = '';
    }
  };
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    // Fast text run: accumulate until a special character.
    if (c > 127 || !SPECIAL_CHARS[c]) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d <= 127 && SPECIAL_CHARS[d]) break;
        j++;
      }
      if (!buf) bufStart = i;
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    // A _, *, ~ or ` that is part of an email local part is plain text,
    // not a delimiter (otherwise the email would be split at the _).
    if ((c === CH_UNDER || c === CH_STAR || c === CH_TILDE || c === CH_BQUOTE) && isInEmail(text, i)) {
      if (!buf) bufStart = i;
      buf += text[i];
      i++;
      continue;
    }
    switch (c) {
      case CH_LF: {
        // Hard break: 2+ trailing spaces in buf.
        let k = buf.length;
        while (k > 0 && buf.charCodeAt(k - 1) === CH_SPACE) k--;
        if (buf.length - k >= 2) {
          buf = buf.slice(0, k);
          flushBuf();
          nodes.push({ t: 6 });
          // A hard break strips the leading whitespace of the next line.
          i++;
          while (i < n && (text.charCodeAt(i) === CH_SPACE || text.charCodeAt(i) === CH_TAB)) i++;
        } else {
          if (!buf) bufStart = i;
          buf += '\n';
          i++;
        }
        break;
      }
      case CH_BSLASH: {
        const nx = i + 1 < n ? text.charCodeAt(i + 1) : -1;
        if (nx === CH_LF) {
          // If buf ends with a bare URL, the backslash is part of the URL
          // (marked's url regex consumes it), not a hard break.
          if (bufEndsWithUrl(buf, bufStart, text)) {
            if (!buf) bufStart = i;
            buf += '\\';
            i++;
            break;
          }
          flushBuf();
          nodes.push({ t: 6 });
          i += 2;
          // A hard break strips the leading whitespace of the next line.
          while (i < n && (text.charCodeAt(i) === CH_SPACE || text.charCodeAt(i) === CH_TAB)) i++;
        } else if (nx >= 0 && isAsciiPunct(nx)) {
          // An escaped & must render as &amp; (it is not an entity start).
          if (!buf) bufStart = i + 1;
          buf += nx === CH_AMP ? '&amp;' : text[i + 1];
          i += 2;
        } else {
          if (!buf) bufStart = i;
          buf += '\\';
          i++;
        }
        break;
      }
      case CH_BQUOTE: {
        let r = i;
        while (r < n && text.charCodeAt(r) === CH_BQUOTE) r++;
        const run = r - i;
        // Find a closing run of exactly `run` backticks.
        let j = r, close = -1;
        while (j < n) {
          if (text.charCodeAt(j) === CH_BQUOTE) {
            let k = j;
            while (k < n && text.charCodeAt(k) === CH_BQUOTE) k++;
            if (k - j === run) { close = j; break; }
            j = k;
          } else j++;
        }
        if (close === -1) {
          if (!buf) bufStart = i;
          buf += '`'.repeat(run);
          i = r;
        } else if (codeSpanBreaksLink(text, r, close, openers, refs)) {
          // The code span would span across the ']' of a link that will
          // form; the link claims the label first, so these backticks are
          // literal text (they are re-parsed inside the link label).
          if (!buf) bufStart = i;
          buf += '`'.repeat(run);
          i = r;
        } else {
          // Newlines become spaces FIRST, then the strip-one-space rule applies.
          let content = text.slice(r, close).replace(/\n/g, ' ');
          if (content.length >= 2 && content.charCodeAt(0) === CH_SPACE && content.charCodeAt(content.length - 1) === CH_SPACE && content.trim() !== '') {
            content = content.slice(1, -1);
          }
          flushBuf();
          nodes.push({ t: 1, s: content });
          i = close + run;
        }
        break;
      }
      case CH_STAR:
      case CH_UNDER: {
        let r = i;
        while (r < n && text.charCodeAt(r) === c) r++;
        const run = r - i;
        const [left, right] = flanking(text, i, run);
        let open, close;
        if (c === CH_STAR) { open = left; close = right; }
        else {
          open = left && (!right || isAsciiPunct(i === 0 ? CH_LF : text.charCodeAt(i - 1)));
          close = right && (!left || isAsciiPunct(i + run >= n ? CH_LF : text.charCodeAt(i + run)));
        }
        flushBuf();
        // pc/nc: the characters before/after the run in the source (for
        // the marked-style opener-forward scan); orig: the original run
        // length (for the rule of 3, which uses the run length, not the
        // remainder). A delimiter inside a masked range (#n) starts dead;
        // it is revived if it lands inside a link that forms.
        nodes.push({ t: 2, ch: String.fromCharCode(c), n: run, open, close, dead: isMaskedPos(maskedRanges, i), pc: i === 0 ? -1 : text.charCodeAt(i - 1), nc: r >= n ? -1 : text.charCodeAt(r), orig: run });
        i = r;
        break;
      }
      case CH_TILDE: {
        let r = i;
        while (r < n && text.charCodeAt(r) === CH_TILDE) r++;
        const run = r - i;
        // A del opener is 1 or 2 tildes followed by a non-space, non-tilde
        // character (a run of 3 tildes never forms a del).
        if (run >= 3) {
          if (!buf) bufStart = i;
          buf += '~'.repeat(run);
          i = r;
          break;
        }
        const [left, right] = flanking(text, i, run);
        flushBuf();
        nodes.push({ t: 2, ch: '~', n: run, open: left, close: right, dead: isMaskedPos(maskedRanges, i), pc: i === 0 ? -1 : text.charCodeAt(i - 1), nc: r >= n ? -1 : text.charCodeAt(r), orig: run });
        i = r;
        break;
      }
      case CH_LBRACK: {
        flushBuf();
        const node = { t: 7, image: false, dead: false, srcPos: i };
        nodes.push(node);
        openers.push({ node, image: false, dead: false, srcPos: i });
        i++;
        break;
      }
      case CH_BANG: {
        if (i + 1 < n && text.charCodeAt(i + 1) === CH_LBRACK) {
          flushBuf();
          const node = { t: 7, image: true, dead: false, srcPos: i };
          nodes.push(node);
          openers.push({ node, image: true, dead: false, srcPos: i });
          i += 2;
        } else {
          if (!buf) bufStart = i;
          buf += '!';
          i++;
        }
        break;
      }
      case CH_RBRACK: {
        // Flush the run as PLAIN text (no autolink scan) so a bare URL can
        // span the ']' if no link forms here. If a link forms, the plain
        // text is correct link text (extended autolinks demote inside links).
        let plainNode = null, plainStart = 0;
        if (buf) {
          plainNode = { t: 0, s: buf, raw: _IN_RAW };
          plainStart = bufStart;
          nodes.push(plainNode);
          buf = '';
        }
        const end = tryLink(text, i, nodes, openers, refs);
        if (end === -1) {
          // No link: pop the plain text back into buf and keep the ']'
          // literal, so a bare URL can continue past it.
          if (plainNode) {
            nodes.pop();
            buf = plainNode.s;
            bufStart = plainStart;
          }
          // If this ']' was followed by '(' (an inline-link attempt that
          // failed), the delimiters inside the label are invisible to
          // emphasis (marked's #n masking of [...](...)) — but ONLY when
          // the label is a valid blockSkip [...] (no nested brackets or
          // links: those break the [...] so only the inner link is masked,
          // and the label's own emphasis still forms, e.g. cm-519).
          // A nested '[' is a t:7 node, a nested ']' is literal in a text
          // node, and a formed nested link is a non-auto t:3 node
          // (autolinks, <...>, do not break the label).
          if (text.charCodeAt(i + 1) === CH_LPAREN && openers.length > 0) {
            const op = openers[openers.length - 1];
            const opIdx = nodes.indexOf(op.node);
            if (opIdx >= 0) {
              let labelValid = true;
              for (let k = opIdx + 1; k < nodes.length; k++) {
                const nd = nodes[k];
                if (nd.t === 7 || (nd.t === 3 && !nd.auto) || (nd.t === 0 && nd.s.indexOf(']') !== -1)) { labelValid = false; break; }
              }
              if (labelValid) {
                for (let k = opIdx + 1; k < nodes.length; k++) {
                  if (nodes[k].t === 2) nodes[k].dead = true;
                }
              }
            }
          }
          if (!buf) bufStart = i;
          buf += ']';
          i++;
        } else i = end;
        break;
      }
      case CH_LT: {
        let done = false;
        const se = matchAngleScheme(text, i);
        if (se !== -1) {
          flushBuf();
          const t = text.slice(i + 1, se - 1);
          nodes.push({ t: 3, href: t, title: null, kids: [{ t: 0, s: t }], auto: true, angle: true });
          i = se;
          done = true;
        } else {
          const ee = matchAngleEmail(text, i);
          if (ee !== -1) {
            flushBuf();
            const t = text.slice(i + 1, ee - 1);
            nodes.push({ t: 3, href: 'mailto:' + t, title: null, kids: [{ t: 0, s: t }], auto: true, angle: true });
            i = ee;
            done = true;
          } else {
            const he = matchHtmlTag(text, i);
            if (he !== -1) {
              flushBuf();
              const tagText = text.slice(i, he);
              updateInlineState(tagText);
              nodes.push({ t: 5, s: tagText });
              i = he;
              done = true;
            }
          }
        }
        if (!done) {
          if (!buf) bufStart = i;
          buf += '<';
          i++;
        }
        break;
      }
      case CH_AMP: {
        // While inside <pre>/<code>/<kbd>/<script>, numeric entities are
        // NOT decoded (marked's inRawBlock).
        const dec = _IN_RAW ? null : decodeNumericRef(text, i);
        if (dec) {
          if (!buf) bufStart = i;
          // A decoded & is not an entity start either.
          buf += dec[0] === '&' ? '&amp;' : dec[0];
          i = dec[1];
        } else if (looksLikeEntity(text, i)) {
          let j = i + 1;
          while (j < n && text.charCodeAt(j) !== CH_SEMI) j++;
          if (!buf) bufStart = i;
          buf += text.slice(i, j + 1);
          i = j + 1;
        } else {
          if (!buf) bufStart = i;
          buf += '&';
          i++;
        }
        break;
      }
      default: {
        if (!buf) bufStart = i;
        buf += text[i];
        i++;
        break;
      }
    }
  }
  flushBuf();
  resolveDelims(nodes);
  const out = [];
  renderInline(nodes, out);
  return out.join('');
}

// ===========================================================================
// Block parser
// ===========================================================================
// A line is {s: string, lazy: boolean}. lazy marks a blockquote lazy
// continuation (added to the open paragraph without block-start checks,
// except for tables).

// Is the line blank (only spaces and tabs)?
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== CH_SPACE && c !== CH_TAB) return false;
  }
  return true;
}

// Remove up to `cols` columns of leading indentation (a tab expands to the
// next multiple of 4; a tab straddling the boundary becomes spaces).
function stripIndent(s, cols) {
  let i = 0, col = 0;
  const n = s.length;
  while (i < n && col < cols) {
    const c = s.charCodeAt(i);
    if (c === CH_SPACE) { col++; i++; }
    else if (c === CH_TAB) {
      const next = col + (4 - (col % 4));
      if (next <= cols) { col = next; i++; }
      else return ' '.repeat(next - cols) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match an ATX heading at s[ci]. Returns {level, text} or null.
function matchAtx(s, ci) {
  let k = ci, level = 0;
  while (s.charCodeAt(k) === CH_HASH && level < 6) { k++; level++; }
  if (level === 0 || level > 6) return null;
  if (k < s.length) {
    const c = s.charCodeAt(k);
    if (c !== CH_SPACE && c !== CH_TAB) return null;
  }
  let text = s.slice(k);
  let a = 0, b = text.length;
  while (a < b && isSpaceCh(text.charCodeAt(a))) a++;
  while (b > a && isSpaceCh(text.charCodeAt(b - 1))) b--;
  text = text.slice(a, b);
  if (text.length > 0 && text.charCodeAt(text.length - 1) === CH_HASH) {
    let r = text.length;
    while (r > 0 && text.charCodeAt(r - 1) === CH_HASH) r--;
    if (r === 0 || isSpaceCh(text.charCodeAt(r - 1))) {
      text = text.slice(0, r);
      while (text.length > 0 && isSpaceCh(text.charCodeAt(text.length - 1))) text = text.slice(0, -1);
    }
  }
  return { level, text };
}

// Match a fenced code block opener at s[ci]. Only backtick and tilde open
// fences. Returns {ch, len, info, indent} or null.
function matchFence(s, ci) {
  const ch = s.charCodeAt(ci);
  if (ch !== CH_BQUOTE && ch !== CH_TILDE) return null;
  let k = ci, len = 0;
  while (s.charCodeAt(k) === ch) { k++; len++; }
  if (len < 3) return null;
  const rest = s.slice(k);
  if (ch === CH_BQUOTE && rest.indexOf('`') !== -1) return null;
  // The first word of the info string (backslash escapes resolved).
  let p = 0;
  while (p < rest.length && (rest.charCodeAt(p) === CH_SPACE || rest.charCodeAt(p) === CH_TAB)) p++;
  let q = p;
  while (q < rest.length && rest.charCodeAt(q) !== CH_SPACE && rest.charCodeAt(q) !== CH_TAB) q++;
  return { ch, len, info: unescapeLinkText(rest.slice(p, q)), indent: leadingIndentWidth(s) };
}

// Is s[ci..] a thematic break (3+ of the same -, *, _ with only spaces)?
function matchHr(s, ci) {
  const ch = s.charCodeAt(ci);
  if (ch !== CH_STAR && ch !== CH_MINUS && ch !== CH_UNDER) return false;
  let count = 0;
  for (let i = ci; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== CH_SPACE && c !== CH_TAB) return false;
  }
  return count >= 3;
}

// Match a setext heading underline at s[ci]. Returns 1 (=), 2 (-), or 0.
// An underline is a run of the same character plus optional trailing
// spaces (no spaces between the characters: "= =" is not an underline).
function matchSetext(s, ci) {
  const ch = s.charCodeAt(ci);
  if (ch !== CH_EQ && ch !== CH_MINUS) return 0;
  let i = ci;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  while (i < s.length && (s.charCodeAt(i) === CH_SPACE || s.charCodeAt(i) === CH_TAB)) i++;
  if (i < s.length) return 0;
  return ch === CH_EQ ? 1 : 2;
}

// Match the start of an HTML block (types 1-6) at s[ci].
// Returns {end} (the string that ends the block, or 'blank') or null.
function matchHtmlBlockStart(s, ci) {
  if (s.charCodeAt(ci) !== CH_LT) return null;
  const rest = s.slice(ci + 1);
  const m1 = /^(script|pre|style|textarea)([\s>]|$)/i.exec(rest);
  if (m1) return { end: '</' + m1[1].toLowerCase() + '>' };
  if (rest.startsWith('!--')) return { end: '-->' };
  if (rest.charCodeAt(0) === 63) return { end: '?>' }; // <?
  if (rest.charCodeAt(0) === CH_BANG && rest.length > 1 && isAlphaCh(rest.charCodeAt(1))) return { end: '>' }; // <!A
  if (rest.startsWith('![CDATA[')) return { end: ']]>' };
  const m6 = /^\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { end: 'blank' };
  return null;
}

// Match an HTML block type 7 at s[ci]: a complete HTML tag and nothing but
// whitespace after it on the line.
function matchHtmlBlock7(s, ci) {
  if (s.charCodeAt(ci) !== CH_LT) return false;
  const end = matchHtmlTag(s, ci);
  if (end === -1) return false;
  for (let k = end; k < s.length; k++) {
    if (!isSpaceCh(s.charCodeAt(k))) return false;
  }
  return true;
}

// Match a list marker at s[ci] with indent ind.
// Returns {ordered, delim, num, indent, contentIndent, empty, content} or null.
function matchListMarker(s, ci, ind) {
  if (ind > 3) return null;
  const c = s.charCodeAt(ci);
  let ordered = false, delim = '', num = 0, markerEnd = 0;
  if (c === CH_MINUS || c === CH_PLUS || c === CH_STAR) {
    delim = String.fromCharCode(c);
    markerEnd = ci + 1;
  } else if (isDigitCh(c)) {
    let k = ci, n = 0;
    while (k < s.length && isDigitCh(s.charCodeAt(k)) && k - ci < 9) { n = n * 10 + (s.charCodeAt(k) - 48); k++; }
    if (k - ci > 9 || k >= s.length) return null;
    const d = s.charCodeAt(k);
    if (d !== CH_DOT && d !== CH_RPAREN) return null;
    ordered = true;
    delim = String.fromCharCode(d);
    num = n;
    markerEnd = k + 1;
  } else return null;
  const markerEndCol = ind + (markerEnd - ci);
  if (markerEnd >= s.length) {
    return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + 1, empty: true, content: '' };
  }
  const nc = s.charCodeAt(markerEnd);
  if (nc !== CH_SPACE && nc !== CH_TAB) return null;
  // Expand the whitespace after the marker (starting at the marker's end
  // column), then measure it in columns.
  const after = expandTabsAtStart(s.slice(markerEnd), markerEndCol);
  let sp = 0;
  while (sp < after.length && after.charCodeAt(sp) === CH_SPACE) sp++;
  const rest = after.slice(sp);
  if (rest.length === 0) {
    return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + 1, empty: true, content: '' };
  }
  if (sp >= 5) return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + 1, empty: false, content: after.slice(1) };
  return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + sp, empty: false, content: rest };
}

// Match a table delimiter row. Returns the alignment array or null.
function matchTableDelimiter(s) {
  const ind = leadingIndentWidth(s);
  if (ind > 3) return null;
  let str = s.slice(indexOfColumn(s, ind));
  let e = str.length;
  while (e > 0 && isSpaceCh(str.charCodeAt(e - 1))) e--;
  str = str.slice(0, e);
  // marked's tableDelimiter: the delimiter row must contain ':' or '|'
  // (a bare '---' is a setext underline, not a table delimiter).
  if (str.indexOf('|') === -1 && str.indexOf(':') === -1) return null;
  if (str.charCodeAt(0) === CH_PIPE) str = str.slice(1);
  if (str.length && str.charCodeAt(str.length - 1) === CH_PIPE) str = str.slice(0, -1);
  if (!str) return null;
  const cells = str.split('|');
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c.charCodeAt(0) === CH_COLON ? (c.charCodeAt(c.length - 1) === CH_COLON ? 'center' : 'left') : (c.charCodeAt(c.length - 1) === CH_COLON ? 'right' : null));
  }
  return aligns;
}

// Split a table row into cells (marked's splitCells): a '|' preceded by an
// odd number of backslashes is a literal '|'; otherwise it is a separator
// (marked as ' |'). Split on ' |', drop leading/trailing empty cells,
// trim, and turn '\|' into '|'.
function splitRow(s, ncols) {
  const t = s.replace(/\|/g, (r, o, str) => {
    let l = false, p = o;
    for (; --p >= 0 && str.charCodeAt(p) === CH_BSLASH;) l = !l;
    return l ? '|' : ' |';
  });
  let cells = t.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (ncols !== undefined) {
    if (cells.length > ncols) cells.length = ncols;
    else while (cells.length < ncols) cells.push('');
  }
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

// Is this line an indented-code line ((?: {4}| {0,3}\t) followed by a
// non-newline character)? A tab-only line is NOT indented code (there is no
// character after the tab), so it IS a table row.
function isIndentedCodeLine(s) {
  const ind = leadingIndentWidth(s);
  if (ind < 4) return false;
  return indexOfColumn(s, 4) < s.length;
}

// Is this line a table body row (marked's table row lookahead)? A row
// continues unless the line is empty or spaces-only (a TAB-only line IS a
// row), or it starts an hr, ATX heading, blockquote, indented code, fence,
// list, or block HTML.
function isTableRowLine(s) {
  if (s.length === 0) return false;
  let onlySpaces = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== CH_SPACE) { onlySpaces = false; break; }
  }
  if (onlySpaces) return false;
  if (isIndentedCodeLine(s)) return false;
  const ind = leadingIndentWidth(s);
  if (ind > 3) return true; // not indented code; no other block starts here
  const ci = indexOfColumn(s, ind);
  const c0 = s.charCodeAt(ci);
  if (c0 === CH_HASH && matchAtx(s, ci)) return false;
  if ((c0 === CH_BQUOTE || c0 === CH_TILDE) && matchFence(s, ci)) return false;
  if (c0 === CH_LT && matchHtmlBlockStart(s, ci)) return false;
  if (c0 === CH_GT) return false;
  if (matchListMarker(s, ci, ind)) return false;
  if ((c0 === CH_STAR || c0 === CH_MINUS || c0 === CH_UNDER) && matchHr(s, ci)) return false;
  return true;
}

// Parse a title starting at s[p] ('"' or "'" or '(').
// Returns {title, end} or null.
function parseTitleAt(s, p) {
  const c = s.charCodeAt(p);
  let close;
  if (c === CH_QUOTE) close = CH_QUOTE;
  else if (c === CH_APOS) close = CH_APOS;
  else if (c === CH_LPAREN) close = CH_RPAREN;
  else return null;
  let q = p + 1;
  while (q < s.length) {
    const d = s.charCodeAt(q);
    if (d === CH_BSLASH && q + 1 < s.length) { q += 2; continue; }
    if (d === close) return { title: unescapeLinkText(s.slice(p + 1, q)), end: q + 1 };
    if (close === CH_RPAREN && (d === CH_LPAREN || d === CH_LF)) return null;
    q++;
  }
  return null;
}

// Parse a link reference definition starting at lines[i].
// Returns {label, href, title, next} or null. A definition may span lines:
// the label may contain newlines, the destination may be on the next line
// (at most one \n after the colon), and a quoted title may span lines or
// sit on the next line. A title must be preceded by whitespace.
function parseRefDef(lines, i) {
  const line = lines[i].s;
  const ind = leadingIndentWidth(line);
  if (ind > 3) return null;
  let p = indexOfColumn(line, ind);
  if (line.charCodeAt(p) !== CH_LBRACK) return null;
  // A joined view of the next few lines (a definition spans at most a few).
  const K = Math.min(12, lines.length - i);
  let t = '';
  for (let k = 0; k < K; k++) {
    if (k > 0) t += '\n';
    t += lines[i + k].s;
  }
  let q = p + 1; // after '['
  // Label: until ']', skipping escaped characters; may contain newlines;
  // must not contain '['.
  const labelStart = q;
  while (q < t.length) {
    const c = t.charCodeAt(q);
    if (c === CH_BSLASH && q + 1 < t.length) { q += 2; continue; }
    if (c === CH_LBRACK) return null;
    if (c === CH_RBRACK) break;
    q++;
  }
  if (q >= t.length || t.charCodeAt(q) !== CH_RBRACK) return null;
  const label = normalizeLabel(t.slice(labelStart, q));
  if (label === '' || label.length > 999) return null;
  q++;
  if (t.charCodeAt(q) !== CH_COLON) return null;
  q++;
  // Spaces, then at most one newline plus spaces/tabs, before the destination.
  while (q < t.length && (t.charCodeAt(q) === CH_SPACE || t.charCodeAt(q) === CH_TAB)) q++;
  if (q < t.length && t.charCodeAt(q) === CH_LF) {
    q++;
    while (q < t.length && (t.charCodeAt(q) === CH_SPACE || t.charCodeAt(q) === CH_TAB)) q++;
  }
  if (q >= t.length) return null;
  // Destination.
  let href;
  if (t.charCodeAt(q) === CH_LT) {
    let r = q + 1, closed = false;
    while (r < t.length) {
      const c = t.charCodeAt(r);
      if (c === CH_LF) break; // an angle destination cannot span lines
      if (c === CH_BSLASH && r + 1 < t.length) { r += 2; continue; }
      if (c === CH_GT) { closed = true; break; }
      if (c === CH_LT) return null;
      r++;
    }
    if (!closed) return null;
    href = unescapeLinkText(t.slice(q + 1, r));
    q = r + 1;
  } else {
    let r = q, depth = 0;
    while (r < t.length) {
      const c = t.charCodeAt(r);
      if (c === CH_SPACE || c === CH_TAB || c === CH_LF) break;
      if (c === CH_BSLASH && r + 1 < t.length) { r += 2; continue; }
      if (c === CH_LPAREN) depth++;
      else if (c === CH_RPAREN) { depth--; if (depth < 0) break; }
      r++;
    }
    if (r === q) return null;
    href = unescapeLinkText(t.slice(q, r));
    q = r;
  }
  // After the destination, try to find a title. A title must be preceded
  // by whitespace (a space on this line, or a newline to the next line).
  // A title opener directly after the destination is not a title: the
  // definition fails.
  let title = null;
  let titleEnd = -1;
  let titleNextLine = false;
  let sp = q;
  while (sp < t.length && (t.charCodeAt(sp) === CH_SPACE || t.charCodeAt(sp) === CH_TAB)) sp++;
  const afterSp = sp < t.length ? t.charCodeAt(sp) : -1;
  if (afterSp === CH_QUOTE || afterSp === CH_APOS || afterSp === CH_LPAREN) {
    // Title on this line (must be preceded by at least one space).
    if (sp === q) return null;
    const tt = parseTitleAt(t, sp);
    if (!tt) return null;
    title = tt.title; titleEnd = tt.end;
  } else if (afterSp === CH_LF) {
    // Try a title on the next line (a failed title falls back to no title).
    let nl = sp + 1;
    while (nl < t.length && (t.charCodeAt(nl) === CH_SPACE || t.charCodeAt(nl) === CH_TAB)) nl++;
    const c2 = nl < t.length ? t.charCodeAt(nl) : -1;
    if (c2 === CH_QUOTE || c2 === CH_APOS || c2 === CH_LPAREN) {
      const tt = parseTitleAt(t, nl);
      if (tt) { title = tt.title; titleEnd = tt.end; titleNextLine = true; }
    }
  } else if (sp >= t.length) {
    // No title; the definition ends at the destination.
  } else {
    return null; // not a title opener and not end of line
  }
  // After the title (or destination), only spaces to end of line.
  let e = title !== null ? titleEnd : sp;
  while (e < t.length && (t.charCodeAt(e) === CH_SPACE || t.charCodeAt(e) === CH_TAB)) e++;
  if (e < t.length && t.charCodeAt(e) !== CH_LF) {
    if (title !== null && titleNextLine) {
      // A next-line title with trailing content: fall back to no title.
      title = null;
      e = sp; // sp is at the \n after the destination
    } else {
      return null;
    }
  }
  const end = e;
  // Lines consumed = 1 + the newlines before end.
  let linesConsumed = 1;
  for (let k = 0; k < end; k++) if (t.charCodeAt(k) === CH_LF) linesConsumed++;
  return { label, href, title, next: i + linesConsumed };
}

// Strip leading link reference definitions from a lines array (in place),
// registering them in refs. Returns the number of lines removed.
function stripRefDefs(lines, refs) {
  let i = 0;
  while (i < lines.length) {
    const r = parseRefDef(lines, i);
    if (!r) break;
    if (!refs.has(r.label)) refs.set(r.label, { href: r.href, title: r.title });
    i = r.next;
  }
  if (i > 0) lines.splice(0, i);
  return i;
}

// Build a paragraph block from lines (extracting leading link ref defs).
// Returns the block, or null when the paragraph was only ref defs.
function makeParagraph(lines, refs) {
  stripRefDefs(lines, refs);
  if (lines.length === 0) return null;
  let text = '';
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) text += '\n';
    text += lines[k].s;
  }
  return { type: 'para', text };
}

// Parse a fenced code block starting at lines[i] (fence already matched).
// Returns the index of the line after the block.
function parseFenced(lines, i, fence, blocks) {
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j].s;
    const li = leadingIndentWidth(line);
    const ci = indexOfColumn(line, li);
    if (li <= 3 && line.charCodeAt(ci) === fence.ch) {
      let k = ci, len = 0;
      while (line.charCodeAt(k) === fence.ch) { k++; len++; }
      if (len >= fence.len) {
        let ok = true;
        for (let m = k; m < line.length; m++) { if (!isSpaceCh(line.charCodeAt(m))) { ok = false; break; } }
        if (ok) { j++; break; }
      }
    }
    content.push(line);
    j++;
  }
  // Indent compensation (marked's Dt): backtick fences only, and only when
  // the opener line has leading whitespace. Each content line loses
  // min(its leading-whitespace length, opener leading-whitespace length)
  // CHARACTERS (a tab counts as one). Tilde fences get no compensation.
  let comp = 0;
  if (fence.ch === CH_BQUOTE) {
    const m = /^(\s+)```/.exec(lines[i].s);
    if (m) comp = m[1].length;
  }
  if (comp > 0) {
    for (let k = 0; k < content.length; k++) {
      const ln = content[k];
      let w = 0;
      while (w < ln.length && (ln.charCodeAt(w) === CH_SPACE || ln.charCodeAt(w) === CH_TAB)) w++;
      if (w > 0) content[k] = ln.slice(Math.min(w, comp));
    }
  }
  // The code text is the lines joined with \n; a trailing \n is added only
  // when the last content line is non-blank (a trailing blank line already
  // supplies it).
  let text = '';
  if (content.length) {
    text = content.join('\n');
    if (content[content.length - 1] !== '') text += '\n';
  }
  blocks.push({ type: 'code', lang: fence.info, text });
  return j;
}

// Parse an indented code block starting at lines[i].
// Returns the index of the line after the block.
function parseIndentedCode(lines, i, blocks) {
  const content = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j].s;
    if (isBlankStr(line)) { content.push(stripIndent(line, 4)); j++; continue; }
    if (leadingIndentWidth(line) >= 4) { content.push(stripIndent(line, 4)); j++; continue; }
    break;
  }
  while (content.length && content[content.length - 1].trim() === '') content.pop();
  blocks.push({ type: 'code', lang: '', text: content.length ? content.join('\n') + '\n' : '' });
  return j;
}

// Parse an HTML block starting at lines[i] (hb already matched).
// Returns the index of the line after the block.
function parseHtmlBlock(lines, i, hb, blocks, isTop) {
  const content = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j].s;
    if (hb.end === 'blank' && isBlankStr(line)) break;
    content.push(line);
    j++;
    if (hb.end !== 'blank' && line.toLowerCase().indexOf(hb.end) !== -1) break;
  }
  // After the end, swallow following blank lines: types 1-5 swallow only
  // truly-empty lines (s === ''), types 6-7 swallow any blank line.
  // The trailing newline is present iff NO blank line followed the block
  // (marked's ge() rule).
  const swallowAny = hb.end === 'blank';
  const isBlankAfter = (s) => swallowAny ? isBlankStr(s) : s === '';
  let hasBlank = false;
  if (j < lines.length) hasBlank = isBlankAfter(lines[j].s);
  while (j < lines.length && isBlankAfter(lines[j].s)) j++;
  // Trailing newline (marked's ge() rule): a block followed by a blank
  // line has none; followed by a non-blank line it keeps one; at the end
  // of its container it keeps one only at the top level when the document
  // ends with a newline.
  let trailing = '\n';
  if (j < lines.length) trailing = hasBlank ? '' : '\n';
  else trailing = (isTop && _DOC_ENDS_NL) ? '\n' : '';
  blocks.push({ type: 'html', text: content.join('\n') + trailing });
  return j;
}

// Parse a table starting at lines[i] (the delimiter row), with the header
// line already identified. Returns the index of the line after the table.
function parseTable(lines, i, headerLine, aligns, blocks, refs) {
  const headerCells = splitRow(headerLine, aligns.length);
  const ncols = aligns.length;
  const rows = [];
  let j = i + 1;
  // A body row continues unless the line ends the table (marked's table
  // row lookahead: empty/spaces-only, or a new block start).
  while (j < lines.length && isTableRowLine(lines[j].s)) {
    const cells = splitRow(lines[j].s, ncols);
    rows.push(cells);
    j++;
  }
  blocks.push({ type: 'table', header: headerCells, aligns, rows });
  return j;
}

// Could the last line of a container hold an open paragraph, so a lazy
// (unindented) line can continue it? Paragraph text, a blockquote line, or
// a list marker whose content is paragraph text or a blockquote line.
function lastLineContinuable(s) {
  if (isParaLine(s)) return true;
  if (/^\s*>/.test(s)) return true;
  const ind = leadingIndentWidth(s);
  const m = matchListMarker(s, indexOfColumn(s, ind), ind);
  if (m && !m.empty) {
    if (isParaLine(m.content) || /^\s*>/.test(m.content)) return true;
  }
  return false;
}

// Could this line be paragraph text (not a block starter, indent <= 3)?
function isParaLine(s) {
  if (isBlankStr(s)) return false;
  const ind = leadingIndentWidth(s);
  if (ind > 3) return false;
  const ci = indexOfColumn(s, ind);
  const c0 = s.charCodeAt(ci);
  if (c0 === CH_HASH && matchAtx(s, ci)) return false;
  if ((c0 === CH_BQUOTE || c0 === CH_TILDE) && matchFence(s, ci)) return false;
  if (c0 === CH_LT && matchHtmlBlockStart(s, ci)) return false;
  if (c0 === CH_GT) return false;
  if (matchListMarker(s, ci, ind)) return false;
  if ((c0 === CH_STAR || c0 === CH_MINUS || c0 === CH_UNDER) && matchHr(s, ci)) return false;
  if ((c0 === CH_EQ || c0 === CH_MINUS) && matchSetext(s, ci)) return false;
  return true;
}

// Is this line a paragraph continuation (a lazy blockquote line)?
function isLazyLine(s) {
  if (isBlankStr(s)) return false;
  const ind = leadingIndentWidth(s);
  if (ind > 3) return true;
  const ci = indexOfColumn(s, ind);
  const c0 = s.charCodeAt(ci);
  if (c0 === CH_HASH && matchAtx(s, ci)) return false;
  if ((c0 === CH_BQUOTE || c0 === CH_TILDE) && matchFence(s, ci)) return false;
  if (c0 === CH_LT && matchHtmlBlockStart(s, ci)) return false;
  if (c0 === CH_GT) return false;
  if (matchListMarker(s, ci, ind)) return false;
  if ((c0 === CH_STAR || c0 === CH_MINUS || c0 === CH_UNDER) && matchHr(s, ci)) return false;
  return true;
}

// Do these lines (in order) end inside a fenced code block? Scans for
// fence openers and closers (``` or ~~~, indent <= 3).
function endsInFence(lines) {
  let fenceCh = 0, fenceLen = 0;
  for (const ln of lines) {
    const s = ln.s;
    if (fenceCh) {
      const ind = leadingIndentWidth(s);
      if (ind <= 3) {
        const ci = indexOfColumn(s, ind);
        if (s.charCodeAt(ci) === fenceCh) {
          let k = ci, len = 0;
          while (s.charCodeAt(k) === fenceCh) { k++; len++; }
          if (len >= fenceLen) {
            let ok = true;
            for (let m = k; m < s.length; m++) { if (!isSpaceCh(s.charCodeAt(m))) { ok = false; break; } }
            if (ok) { fenceCh = 0; fenceLen = 0; }
          }
        }
      }
      continue;
    }
    const ind = leadingIndentWidth(s);
    if (ind > 3) continue;
    const ci = indexOfColumn(s, ind);
    // matchFence (which now requires a backtick/tilde) is used so a
    // ```inner backticks``` line is NOT a fence opener (a backtick fence's
    // info string must not contain backticks).
    const f = matchFence(s, ci);
    if (f) { fenceCh = f.ch; fenceLen = f.len; }
  }
  return fenceCh !== 0;
}

// Parse a blockquote starting at lines[i].
// Returns the index of the line after the blockquote.
function parseBlockquote(lines, i, blocks, refs, inListItem) {
  const inner = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j].s;
    const ind = leadingIndentWidth(line);
    if (ind <= 3) {
      const ci = indexOfColumn(line, ind);
      if (line.charCodeAt(ci) === CH_GT) {
        // Expand the whitespace after > (starting at the column after >),
        // then remove one column (the space after >).
        const afterGt = line.slice(ci + 1);
        const expanded = expandTabsAtStart(afterGt, ind + 1);
        const content = expanded.charCodeAt(0) === CH_SPACE ? expanded.slice(1) : expanded;
        inner.push({ s: content, lazy: false });
        j++;
        continue;
      }
    }
    // Lazy continuation: only when the last inner line could hold an open
    // paragraph (itself, or a nested blockquote / list item containing one),
    // and the blockquote does not end inside a fenced code block (a lazy
    // line cannot continue a code block).
    if (inner.length > 0 && lastLineContinuable(inner[inner.length - 1].s) && !endsInFence(inner) && isLazyLine(line)) {
      inner.push({ s: line, lazy: true });
      j++;
      continue;
    }
    break;
  }
  blocks.push({ type: 'blockquote', children: parseBlockLines(inner, refs, false, inListItem) });
  return j;
}

// Parse a list starting at lines[i].
// Returns the index of the line after the list.
function parseList(lines, i, blocks, refs) {
  const firstLine = lines[i].s;
  const first = matchListMarker(firstLine, indexOfColumn(firstLine, leadingIndentWidth(firstLine)), leadingIndentWidth(firstLine));
  const ordered = first.ordered;
  const delim = first.delim;
  const items = [];
  let cur = { lines: [{ s: first.content, lazy: false }], sawBlank: false };
  let curIndent = first.contentIndent;
  const curIsEmpty = () => {
    for (const l of cur.lines) if (!isBlankStr(l.s)) return false;
    return true;
  };
  // Is the item's last line continuable by a lazy (unindented) line?
  const lastContinuable = () => {
    if (cur.lines.length === 0) return false;
    const lastObj = cur.lines[cur.lines.length - 1];
    const last = lastObj.s;
    if (isBlankStr(last)) return false;
    // A lazy line is paragraph text (it was added as a lazy continuation),
    // even when indented past 3 columns.
    if (lastObj.lazy) return true;
    if (isParaLine(last)) return true;
    // A blockquote line can continue (its paragraph is open).
    return /^\s*>/.test(last);
  };
  let j = i + 1;
  // Buffered blank lines: flushed into the current item only when a
  // following line belongs to it. A blank line ends lazy continuation, so
  // an unindented line after a blank line does not continue the item.
  let pending = [];
  while (j < lines.length) {
    const ln = lines[j];
    const line = ln.s;
    if (isBlankStr(line)) {
      pending.push({ s: '', lazy: false });
      j++;
      continue;
    }
    const ind = leadingIndentWidth(line);
    const ci = indexOfColumn(line, ind);
    const c0 = line.charCodeAt(ci);
    // An hr at a possible sibling indent ends the list.
    if (ind <= Math.min(3, curIndent - 1) && (c0 === CH_STAR || c0 === CH_MINUS || c0 === CH_UNDER) && matchHr(line, ci)) {
      break;
    }
    const m = matchListMarker(line, ci, ind);
    if (m && m.ordered === ordered && m.delim === delim) {
      // A new sibling iff the marker indent is <= min(3, R-1) of the current item.
      if (ind <= Math.min(3, curIndent - 1)) {
        // Flush pending blanks into the previous item first.
        if (pending.length) { cur.lines.push(...pending); cur.sawBlank = true; pending = []; }
        items.push(cur);
        cur = { lines: [{ s: m.content, lazy: false }], sawBlank: false };
        curIndent = m.contentIndent;
        j++;
        continue;
      }
      // Otherwise it belongs to the current item (fall through).
    } else if (m && ind <= Math.min(3, curIndent - 1)) {
      // A different list type or delimiter at a sibling indent ends this list.
      // At a deeper indent it is a nested list inside the current item.
      break;
    }
    if (!cur) break;
    // An empty item followed by a blank line is closed.
    if (curIsEmpty() && (cur.sawBlank || pending.length > 0)) break;
    // Lazy continuation (from a blockquote): the line is appended as-is
    // (marked does not strip its leading whitespace). Not after a blank
    // line, and not when the line starts a block (fence, heading, hr,
    // blockquote, list, html) — such a line ends the item instead.
    if (ln.lazy && lastContinuable() && pending.length === 0 && isLazyLine(line)) {
      if (/^ {0,3}(?:=+|-+) *$/.test(line)) {
        cur.lines.push({ s: '    ' + line.replace(/^ {0,3}/, ''), lazy: true });
      } else {
        cur.lines.push({ s: line, lazy: true });
      }
      j++;
      continue;
    }
    // Indented to the content indent: part of the item (expand, strip R columns).
    if (ind >= curIndent) {
      if (pending.length) { cur.lines.push(...pending); cur.sawBlank = true; pending = []; }
      cur.lines.push({ s: stripIndentExpanded(line, curIndent), lazy: false });
      j++;
      continue;
    }
    // Unindented line: lazy paragraph continuation of the item.
    // The line is appended as-is (marked does not strip leading whitespace).
    // Not after a blank line, and not when the line starts a block
    // (fence, heading, hr, blockquote, list, html).
    if (lastContinuable() && pending.length === 0 && isLazyLine(line)) {
      if (/^ {0,3}(?:=+|-+) *$/.test(line)) {
        cur.lines.push({ s: '    ' + line.replace(/^ {0,3}/, ''), lazy: true });
      } else {
        cur.lines.push({ s: line, lazy: true });
      }
      j++;
      continue;
    }
    break;
  }
  if (cur) items.push(cur);
  const last = items[items.length - 1];
  while (last.lines.length && isBlankStr(last.lines[last.lines.length - 1].s)) last.lines.pop();
  let loose = false;
  const parsed = [];
  for (let k = 0; k < items.length; k++) {
    const ls = items[k].lines;
    let firstNb = -1, lastNb = -1;
    for (let m = 0; m < ls.length; m++) {
      if (!isBlankStr(ls[m].s)) { if (firstNb < 0) firstNb = m; lastNb = m; }
    }
    const trimmed = firstNb < 0 ? [] : ls.slice(0, lastNb + 1);
    const itemBlocks = parseBlockLines(trimmed, refs, false, true);
    // Task list: the item's first paragraph may start with [ ] / [x] / [X]
    // followed by whitespace or end of text. Strip the marker and record it.
    if (itemBlocks.length > 0 && itemBlocks[0].type === 'para') {
      const t = itemBlocks[0].text;
      if (t.length >= 3 && t.charCodeAt(0) === CH_LBRACK && t.charCodeAt(2) === CH_RBRACK &&
          (t.charCodeAt(1) === CH_SPACE || t.charCodeAt(1) === 120 || t.charCodeAt(1) === 88) &&
          (t.length === 3 || isWsCh(t.charCodeAt(3)))) {
        itemBlocks[0].task = t.charCodeAt(1) === CH_SPACE ? 'unchecked' : 'checked';
        itemBlocks[0].text = t.slice(3);
      }
    }
    // Loose when the item directly contains two blocks separated by a blank line.
    if (itemBlocks.loose) loose = true;
    // Loose when a (source) blank line separates this item from the next.
    // An empty item's own empty content is not a blank-line separator.
    if (k < items.length - 1 && items[k].sawBlank && ls.length > 0 && isBlankStr(ls[ls.length - 1].s)) loose = true;
    parsed.push(itemBlocks);
  }
  blocks.push({ type: 'list', ordered, start: ordered ? first.num : 0, loose, items: parsed });
  // Rewind past buffered blank lines so the caller re-processes them.
  return j - pending.length;
}

// The block dispatcher: lines -> a list of blocks.
function parseBlockLines(lines, refs, isTop, inListItem) {
  const blocks = [];
  // Looseness: a blank line between two direct blocks makes this level loose.
  // (Blank lines inside a nested list or code block do not count.)
  let sawBlank = false;
  let loose = false;
  const noteBlock = () => {
    if (sawBlank && blocks.length > 0) loose = true;
    sawBlank = false;
  };
  let i = 0;
  const n = lines.length;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      const b = makeParagraph(para, refs);
      if (b) { noteBlock(); blocks.push(b); }
      para = [];
    }
  };
  while (i < n) {
    const ln = lines[i];
    const line = ln.s;
    if (isBlankStr(line)) {
      // A trailing spaces-only line (the last line, no following newline)
      // is paragraph content, not a blank line.
      if (para.length > 0 && i === n - 1 && line.length > 0) {
        para.push(ln);
        i++;
        continue;
      }
      flushPara(); sawBlank = true; i++; continue;
    }
    const ind = leadingIndentWidth(line);
    const ci = indexOfColumn(line, ind);
    const c0 = line.charCodeAt(ci);
    if (ln.lazy) {
      // Lazy continuation: only the table check applies.
      if (para.length > 0) {
        const aligns = matchTableDelimiter(line);
        // The delimiter column count must equal the header column count.
        if (aligns && splitRow(para[para.length - 1].s).length === aligns.length) {
          const headerLine = para[para.length - 1].s;
          para.pop();
          flushPara();
          i = parseTable(lines, i, headerLine, aligns, blocks, refs);
          continue;
        }
        // A lazy setext underline following a lazy line is indented by 4
        // spaces so it stays paragraph text (marked's blockquoteSetextReplace).
        // A lazy line indented 4+ is lexed as code and merged into the
        // paragraph with its indent removed.
        const prevLazy = para[para.length - 1].lazy;
        let pushLine = ln;
        if (prevLazy && /^ {0,3}(?:=+|-+) *$/.test(line)) {
          pushLine = { s: '    ' + line.replace(/^ {0,3}/, ''), lazy: true };
        } else if (leadingIndentWidth(line) >= 4) {
          pushLine = { s: stripIndent(line, 4), lazy: true };
        }
        para.push(pushLine);
        i++;
        continue;
      }
      // No paragraph open: fall through to the normal checks.
    }
    if (ind >= 4) {
      if (para.length === 0) { noteBlock(); i = parseIndentedCode(lines, i, blocks); continue; }
      para.push(ln);
      i++;
      continue;
    }
    // Setext heading (only when a paragraph is open).
    if (para.length > 0 && (c0 === CH_EQ || c0 === CH_MINUS)) {
      const su = matchSetext(line, ci);
      if (su) {
        // Leading ref defs are stripped first: if nothing is left, the
        // underline is not a heading (it becomes a paragraph line).
        stripRefDefs(para, refs);
        if (para.length === 0) {
          para.push(ln);
          i++;
          continue;
        }
        let text = '';
        for (let k = 0; k < para.length; k++) {
          if (k > 0) text += '\n';
          text += para[k].s;
        }
        para = [];
        noteBlock();
        blocks.push({ type: 'heading', level: su, text: text.trim() });
        i++;
        continue;
      }
    }
    // ATX heading.
    if (c0 === CH_HASH) {
      const h = matchAtx(line, ci);
      if (h) { flushPara(); noteBlock(); blocks.push({ type: 'heading', level: h.level, text: h.text }); i++; continue; }
    }
    // Fenced code.
    if (c0 === CH_BQUOTE || c0 === CH_TILDE) {
      const f = matchFence(line, ci);
      if (f) { flushPara(); noteBlock(); i = parseFenced(lines, i, f, blocks); continue; }
    }
    // HTML block types 1-6.
    if (c0 === CH_LT) {
      const hb = matchHtmlBlockStart(line, ci);
      if (hb) { flushPara(); noteBlock(); i = parseHtmlBlock(lines, i, hb, blocks, isTop); continue; }
    }
    // Blockquote.
    if (c0 === CH_GT) {
      flushPara(); noteBlock();
      i = parseBlockquote(lines, i, blocks, refs, inListItem);
      continue;
    }
    // Thematic break (checked before list: "- - -" and "* * *" are hr, not lists).
    if (c0 === CH_STAR || c0 === CH_MINUS || c0 === CH_UNDER) {
      if (matchHr(line, ci)) { flushPara(); noteBlock(); blocks.push({ type: 'hr' }); i++; continue; }
    }
    // List.
    const lm = matchListMarker(line, ci, ind);
    if (lm) {
      let canInterrupt = true;
      if (para.length > 0) {
        if (lm.empty) canInterrupt = false;
        // An ordered list must start with 1 to interrupt a paragraph,
        // except inside a list item (where any start number interrupts).
        else if (lm.ordered && lm.num !== 1 && !inListItem) canInterrupt = false;
      }
      if (canInterrupt) {
        flushPara(); noteBlock();
        i = parseList(lines, i, blocks, refs);
        continue;
      }
    }
    // Table delimiter (only when a paragraph is open).
    if (para.length > 0) {
      const aligns = matchTableDelimiter(line);
      // The delimiter column count must equal the header column count.
      if (aligns && splitRow(para[para.length - 1].s).length === aligns.length) {
        const headerLine = para[para.length - 1].s;
        para.pop();
        flushPara();
        noteBlock();
        i = parseTable(lines, i, headerLine, aligns, blocks, refs);
        continue;
      }
    }
    // HTML block type 7 (only when no paragraph is open).
    if (para.length === 0 && c0 === CH_LT) {
      if (matchHtmlBlock7(line, ci)) { i = parseHtmlBlock(lines, i, { end: 'blank' }, blocks, isTop); continue; }
    }
    // Paragraph line.
    // A blank line followed by content at this level (even a ref def, which
    // creates no block) makes this level loose.
    if (sawBlank && blocks.length > 0) loose = true;
    para.push(ln);
    i++;
  }
  flushPara();
  blocks.loose = loose;
  return blocks;
}

// Render blocks to HTML. `tight` = inside a tight list item (paragraphs
// render bare, without <p> tags).
function renderBlocks(blocks, refs, out, tight) {
  for (const b of blocks) {
    switch (b.type) {
      case 'para': {
        const taskHtml = b.task ? (b.task === 'checked' ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">') : '';
        if (tight) out.push(taskHtml + parseInline(b.text, refs));
        else out.push('<p>' + taskHtml + parseInline(b.text, refs) + '</p>\n');
        break;
      }
      case 'heading':
        out.push('<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n');
        break;
      case 'code':
        out.push('<pre><code' + (b.lang ? ' class="language-' + escapeInlineText(b.lang) + '"' : '') + '>' + escapeCodeText(b.text) + '</code></pre>\n');
        break;
      case 'html':
        out.push(b.text);
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'blockquote':
        out.push('<blockquote>\n');
        renderBlocks(b.children, refs, out, false);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n');
        for (const item of b.items) {
          out.push('<li>');
          renderBlocks(item, refs, out, !b.loose);
          out.push('</li>\n');
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let k = 0; k < b.header.length; k++) {
          const a = b.aligns[k];
          out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(b.header[k], refs) + '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let k = 0; k < row.length; k++) {
              const a = b.aligns[k];
              out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(row[k], refs) + '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

// Does the source document end with a newline? (For the HTML-block
// trailing-newline rule.)
let _DOC_ENDS_NL = false;

export function parse(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  _DOC_ENDS_NL = text.endsWith('\n');
  _IN_LINK = false; _IN_RAW = false;
  const refs = new Map();
  const rawLines = text.split('\n');
  // A trailing newline is a line terminator, not an extra empty line.
  if (_DOC_ENDS_NL) rawLines.pop();
  const lines = new Array(rawLines.length);
  for (let i = 0; i < rawLines.length; i++) lines[i] = { s: rawLines[i], lazy: false };
  const blocks = parseBlockLines(lines, refs, true, false);
  const out = [];
  renderBlocks(blocks, refs, out, false);
  return out.join('');
}
