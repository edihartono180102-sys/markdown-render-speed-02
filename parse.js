// A fast drop-in for marked 18.1.3 (default options: gfm on, breaks off, pedantic off,
// async off). parse(markdown) returns exactly the HTML marked.parse(markdown) returns.
// Written from the CommonMark 0.31.2 + GFM 0.29 specs and verified against marked's
// own output on the competition's practice set. No dependencies, no network, no clock.

'use strict';

// ---- character helpers ----
const C_SPACE = 32, C_TAB = 9, C_LF = 10, C_CR = 13, C_BANG = 33, C_QUOT = 34,
  C_HASH = 35, C_DOLLAR = 36, C_PCT = 37, C_AMP = 38, C_APOS = 39, C_LPAREN = 40,
  C_RPAREN = 41, C_STAR = 42, C_PLUS = 43, C_COMMA = 44, C_MINUS = 45, C_DOT = 46,
  C_SLASH = 47, C_COLON = 58, C_SEMI = 59, C_LT = 60, C_EQ = 61, C_GT = 62,
  C_QUEST = 63, C_AT = 64, C_LBRACK = 91, C_BSLASH = 92, C_RBRACK = 93, C_CARET = 94,
  C_UNDER = 95, C_BQUOTE = 96, C_LBRACE = 123, C_PIPE = 124, C_RBRACE = 125,
  C_TILDE = 126;

function isSpace(c) { return c === C_SPACE || c === C_TAB; }
function isWhitespace(c) {
  // JS \s (what marked's regexes use): ASCII whitespace + Unicode spaces.
  return c === C_SPACE || c === C_TAB || c === C_LF || c === C_CR || c === 0x0b || c === 0x0c
    || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
    || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Punctuation for flanking (CommonMark): ASCII punct + Unicode P/S categories
// ($, £, € are all symbols, so they count as punctuation here).
const FLANK_PUNCT_RE = /[\p{P}\p{S}]/u;
function isFlankPunct(c) {
  if (c < 128) return isPunct(c);
  return FLANK_PUNCT_RE.test(String.fromCharCode(c));
}
function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

// ---- HTML escaping ----
// Smart escape for inline text: & < > " ' are escaped, except an & that begins an
// entity-like sequence &name; / &#123; / &#x1a; (those pass through untouched, which
// is what marked does: it leaves named entities alone and decodes numeric ones
// before escaping). Code spans/blocks use escapeRaw (every & is escaped).
function escapeSmart(s) {
  let out = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === C_AMP) {
      if (!isEntityLike(s, i)) rep = '&amp;';
    } else if (c === C_LT) rep = '&lt;';
    else if (c === C_GT) rep = '&gt;';
    else if (c === C_QUOT) rep = '&quot;';
    else if (c === C_APOS) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? s : out + s.slice(last);
}

function escapeRaw(s) {
  let out = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === C_AMP) rep = '&amp;';
    else if (c === C_LT) rep = '&lt;';
    else if (c === C_GT) rep = '&gt;';
    else if (c === C_QUOT) rep = '&quot;';
    else if (c === C_APOS) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? s : out + s.slice(last);
}

// Is s[i] == '&' the start of an entity-like sequence (&name; / &#123; / &#x1a;)?
function isEntityLike(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return false;
  if (s.charCodeAt(j) === C_HASH) {
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const st = j;
      while (j < n && hexVal(s.charCodeAt(j)) >= 0) j++;
      // marked: hex entities are at most 6 digits
      return j > st && j - st <= 6 && j < n && s.charCodeAt(j) === C_SEMI;
    }
    const st = j;
    while (j < n && isDigit(s.charCodeAt(j))) j++;
    // marked: decimal entities are at most 7 digits
    return j > st && j - st <= 7 && j < n && s.charCodeAt(j) === C_SEMI;
  }
  const st = j;
  while (j < n && isAlnum(s.charCodeAt(j))) j++;
  return j > st && j < n && s.charCodeAt(j) === C_SEMI;
}

// Decode a numeric entity at s[i] ('&#...;'): returns [char, endIndex] or null.
function decodeNumericEntity(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== C_HASH) return null;
  j++;
  let cp = 0;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    j++;
    const st = j;
    while (j < n && hexVal(s.charCodeAt(j)) >= 0) {
      cp = cp * 16 + hexVal(s.charCodeAt(j));
      if (cp > 0x10ffff) cp = 0x110000;
      j++;
    }
    // marked: hex entities are at most 6 digits
    if (j === st || j - st > 6 || j >= n || s.charCodeAt(j) !== C_SEMI) return null;
  } else {
    const st = j;
    while (j < n && isDigit(s.charCodeAt(j))) {
      cp = cp * 10 + (s.charCodeAt(j) - 48);
      if (cp > 0x10ffff) cp = 0x110000;
      j++;
    }
    // marked: decimal entities are at most 7 digits
    if (j === st || j - st > 7 || j >= n || s.charCodeAt(j) !== C_SEMI) return null;
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// cleanUrl: encode a link destination the way marked does (encodeURI, then %25 -> %).
// Returns null when encodeURI throws (lone surrogate).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---- tab/column helpers for lines ----
// Expand the leading tabs of s to spaces (marked's J), starting at column
// startCol. Only the leading whitespace is touched.
function expandLeadingTabs(s, startCol) {
  let col = startCol, i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C_TAB) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else if (c === C_SPACE) {
      out += ' ';
      col++;
      i++;
    } else break;
  }
  return out + s.slice(i);
}

// Remove `cols` columns of leading indent, expanding tabs to spaces first
// (marked's list/blockquote rule: expand, then strip exactly R columns).
function stripColsExpanded(line, cols) {
  return expandLeadingTabs(line, 0).slice(cols);
}

// Column width of the leading whitespace of line (tab = next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === C_SPACE) col++;
    else if (c === C_TAB) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `cols` columns of indent from the start of line (tab-aware: a tab that
// straddles the boundary becomes the right number of spaces).
function stripCols(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === C_SPACE) { col++; i++; }
    else if (c === C_TAB) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        // tab straddles: replace with spaces for the remainder
        return ' '.repeat(col + w - cols) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}

// Column of character index idx in line (tab-aware).
function colOf(line, idx) {
  let col = 0;
  for (let i = 0; i < idx && i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === C_TAB) col += 4 - (col % 4);
    else col++;
  }
  return col;
}

// Index in line of the given column (tab-aware); returns line.length if beyond.
function idxOfCol(line, col) {
  let c = 0, i = 0;
  while (i < line.length && c < col) {
    const ch = line.charCodeAt(i);
    if (ch === C_TAB) c += 4 - (c % 4);
    else c++;
    i++;
  }
  return i;
}

// ============================================================================
// Inline parsing
// ============================================================================

// Normalize a link label: collapse whitespace (incl. newlines) to single spaces,
// trim, lowercase.
function normalizeLabel(s) {
  // Unicode case folding: ß/ẞ fold to "ss" (cm-540: [ẞ] matches [SS]).
  s = s.replace(/[\u00DF\u1E9E]/g, 'ss');
  let out = '';
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWhitespace(c)) {
      if (!lastSpace) { out += ' '; lastSpace = true; }
    } else {
      out += String.fromCharCode(c).toLowerCase();
      lastSpace = false;
    }
  }
  if (lastSpace && out.length > 0) out = out.slice(0, -1);
  return out;
}

// Flanking for a delimiter run at [i, i+n) in s. prev/next are the adjacent chars
// (or '\n' at the boundaries, as cmark does).
function flanking(s, i, n) {
  const prev = i === 0 ? C_LF : s.charCodeAt(i - 1);
  const next = i + n >= s.length ? C_LF : s.charCodeAt(i + n);
  const prevWs = isWhitespace(prev), nextWs = isWhitespace(next);
  const prevPunct = isFlankPunct(prev), nextPunct = isFlankPunct(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// Parse a link destination starting at s[i] (after '(' or after '[' label colon).
// Returns {dest, end} (end = index after the destination) or null.
function parseDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === C_LT) {
    let j = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === C_GT) return { dest: s.slice(i + 1, j), end: j + 1 };
      if (c === C_LT || c === C_LF || c === C_CR) return null;
      if (c === C_BSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) j++;
      j++;
    }
    return null;
  }
  // Bare destination: no spaces/control chars, balanced parens.
  let j = i, depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 127) break;
    if (c === C_BSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === C_LPAREN) depth++;
    else if (c === C_RPAREN) {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: s.slice(i, j), end: j };
}

// Parse a link title starting at s[i] (after destination + whitespace).
// Returns {title, end} or null. Title may be "..." '...' or (...).
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  if (q !== C_QUOT && q !== C_APOS && q !== C_LPAREN) return null;
  const close = q === C_LPAREN ? C_RPAREN : q;
  let j = i + 1, out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === close) return { title: out, end: j + 1 };
    if (c === C_LF) {
      if (q === C_LPAREN) return null;
      out += '\n'; j++;
      continue;
    }
    if (c === C_BSLASH && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { out += s[j + 1]; j += 2; continue; }
    out += s[j];
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines from i; returns new index.
function skipWs(s, i) {
  while (i < s.length && isWhitespace(s.charCodeAt(i))) i++;
  return i;
}

// Try to parse an inline link's (dest "title") starting at s[i] == '('.
// Returns {href, title, end} or null.
function parseInlineLink(s, i, refs) {
  const n = s.length;
  let j = skipWs(s, i + 1);
  let href;
  if (j < n && s.charCodeAt(j) === C_RPAREN) {
    href = ''; // empty destination: [link]()
  } else {
    const d = parseDestination(s, j);
    if (!d) return null;
    href = d.dest;
    j = skipWs(s, d.end);
  }
  let title = null;
  if (j < n && (s.charCodeAt(j) === C_QUOT || s.charCodeAt(j) === C_APOS || s.charCodeAt(j) === C_LPAREN)) {
    const t = parseTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = skipWs(s, t.end);
  }
  if (j >= n || s.charCodeAt(j) !== C_RPAREN) return null;
  return { href: unescapeText(href), title: title === null ? null : unescapeText(title), end: j + 1 };
}

// Resolve backslash escapes and numeric entities in a link destination/title.
// (Named entities are left alone; the renderer’s smart escape passes them through.)
function unescapeText(s) {
  let out = null, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === C_BSLASH && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) {
      if (out === null) out = '';
      // An escaped & is not an entity start.
      out += s.slice(last, i) + (s.charCodeAt(i + 1) === C_AMP ? '&amp;' : s[i + 1]);
      i++;
      last = i + 1;
    } else if (c === C_AMP) {
      const dec = decodeNumericEntity(s, i);
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

// Match an HTML tag / comment / PI / declaration / CDATA at s[i] == '<'.
// Returns the end index (exclusive) or -1.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === C_BANG) {
    if (s.startsWith('<!--', i)) {
      // abruptly-closed comments <!--> and <!---> are valid comments
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    // Declaration: <! + letter ... >
    if (i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
      const e = s.indexOf('>', i + 2);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (c1 === C_QUEST) {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (c1 === C_SLASH) {
    if (i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === C_MINUS)) j++;
      j = skipWs(s, j);
      if (j < n && s.charCodeAt(j) === C_GT) return j + 1;
    }
    return -1;
  }
  if (isAlpha(c1)) {
    let j = i + 1;
    while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === C_MINUS)) j++;
    // attributes (each must be preceded by whitespace; whitespace skipped
    // while looking for an `=` after a boolean attribute counts as the
    // whitespace before the next attribute)
    let wsBefore = false;
    for (;;) {
      const wsStart = j;
      j = skipWs(s, j);
      if (j >= n) return -1;
      if (j > wsStart) wsBefore = true;
      const c = s.charCodeAt(j);
      if (c === C_GT) return j + 1;
      if (c === C_SLASH && j + 1 < n && s.charCodeAt(j + 1) === C_GT) return j + 2;
      if (!wsBefore) return -1; // no whitespace before the attribute
      if (!isAlpha(c) && c !== C_UNDER && c !== C_COLON) return -1;
      while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === C_UNDER || s.charCodeAt(j) === C_COLON || s.charCodeAt(j) === C_MINUS || s.charCodeAt(j) === C_DOT)) j++;
      wsBefore = false;
      const eqStart = j;
      j = skipWs(s, j);
      if (j > eqStart) wsBefore = true;
      if (j < n && s.charCodeAt(j) === C_EQ) {
        wsBefore = false;
        j++;
        j = skipWs(s, j);
        if (j >= n) return -1;
        const q = s.charCodeAt(j);
        if (q === C_QUOT || q === C_APOS) {
          j++;
          while (j < n && s.charCodeAt(j) !== q) j++;
          if (j >= n) return -1;
          j++;
        } else {
          const st = j;
          while (j < n) {
            const ch = s.charCodeAt(j);
            if (ch <= 32 || ch === C_QUOT || ch === C_APOS || ch === C_EQ || ch === C_LT || ch === C_GT || ch === C_BQUOTE) break;
            j++;
          }
          if (j === st) return -1;
        }
      }
    }
  }
  return -1;
}

// Email pattern for <...> autolinks (CommonMark).
function matchAngleEmail(s, i) {
  // s[i] == '<'; returns end index or -1
  const n = s.length;
  let j = i + 1;
  const localStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === C_DOT || c === C_BANG || c === C_HASH || c === C_DOLLAR || c === C_PCT || c === C_AMP || c === C_APOS || c === C_STAR || c === C_PLUS || c === C_SLASH || c === C_EQ || c === C_QUEST || c === C_CARET || c === C_UNDER || c === C_BQUOTE || c === C_LBRACE || c === C_PIPE || c === C_RBRACE || c === C_TILDE || c === C_MINUS) j++;
    else break;
  }
  if (j === localStart || j >= n || s.charCodeAt(j) !== C_AT) return -1;
  j++;
  const domStart = j;
  let dots = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === C_MINUS) j++;
    else if (c === C_DOT) { dots++; j++; }
    else break;
  }
  if (j === domStart || dots === 0) return -1;
  if (j >= n || s.charCodeAt(j) !== C_GT) return -1;
  // domain must not start/end with - or .
  const dom = s.slice(domStart, j);
  if (dom.charCodeAt(0) === C_MINUS || dom.charCodeAt(0) === C_DOT || dom.charCodeAt(dom.length - 1) === C_MINUS || dom.charCodeAt(dom.length - 1) === C_DOT) return -1;
  return j + 1;
}

// Angle autolink <scheme:...>: returns end index or -1.
function matchAngleScheme(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  j++;
  let len = 1;
  while (j < n && len < 32) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === C_PLUS || c === C_MINUS || c === C_DOT) { j++; len++; }
    else break;
  }
  // A scheme is 2-32 characters.
  if (len < 2) return -1;
  if (j >= n || s.charCodeAt(j) !== C_COLON) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === C_GT) return j + 1;
    if (c === C_SPACE || c === C_LT || c === C_LF) return -1;
    j++;
  }
  return -1;
}

// Trim trailing punctuation / unbalanced parens from a bare autolink candidate.
// Returns the end index of the link text.
function trimAutolink(s, start, end) {
  let e = end;
  // A trailing entity-like &name; is not part of the URL (gfm-627).
  // Check before stripping the ';' (which is part of the entity).
  const tail = s.slice(start, e);
  const em = /&[a-zA-Z0-9]+;$/.exec(tail);
  if (em) e -= em[0].length;
  // strip trailing punctuation . , ; : ! ? * _ ~ ' "
  while (e > start) {
    const c = s.charCodeAt(e - 1);
    if (c === C_DOT || c === C_COMMA || c === C_SEMI || c === C_COLON || c === C_BANG || c === C_QUEST || c === C_STAR || c === C_UNDER || c === C_TILDE || c === C_APOS || c === C_QUOT) e--;
    else break;
  }
  // balance parens: if more ) than (, strip trailing )
  while (e > start && s.charCodeAt(e - 1) === C_RPAREN) {
    let open = 0, close = 0;
    for (let k = start; k < e; k++) {
      if (s.charCodeAt(k) === C_LPAREN) open++;
      else if (s.charCodeAt(k) === C_RPAREN) close++;
    }
    if (close > open) e--;
    else break;
  }
  return e;
}

// Is c a valid email local-part char?
function isEmailLocalChar(c) {
  return isAlnum(c) || c === C_DOT || c === C_BANG || c === C_HASH || c === C_DOLLAR || c === C_PCT || c === C_AMP || c === C_APOS || c === C_STAR || c === C_PLUS || c === C_SLASH || c === C_EQ || c === C_QUEST || c === C_CARET || c === C_UNDER || c === C_BQUOTE || c === C_LBRACE || c === C_PIPE || c === C_RBRACE || c === C_TILDE || c === C_MINUS;
}

// Is the char at text[i] part of a valid email (local@domain.tld)?
// Used so that _, *, ~, ` in an email local part are treated as text
// instead of emphasis/code delimiters (which would split the email).
function isInEmail(text, i) {
  const n = text.length;
  if (!isEmailLocalChar(text.charCodeAt(i))) return false;
  // forward: valid local-part chars up to @
  let j = i;
  while (j < n && isEmailLocalChar(text.charCodeAt(j))) j++;
  if (j >= n || text.charCodeAt(j) !== C_AT) return false;
  // domain after @
  let k = j + 1;
  const domStart = k;
  let dots = 0;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (isAlnum(c) || c === C_MINUS) k++;
    else if (c === C_DOT) { dots++; k++; }
    else break;
  }
  let de = k;
  while (de > domStart && (text.charCodeAt(de - 1) === C_DOT || text.charCodeAt(de - 1) === C_MINUS)) de--;
  if (de === domStart || dots === 0) return false;
  const dom = text.slice(domStart, de);
  if (dom.charCodeAt(0) === C_MINUS || dom.charCodeAt(0) === C_DOT) return false;
  if (de < n) {
    const nc = text.charCodeAt(de);
    if (isAlnum(nc) || nc === C_UNDER || nc === C_MINUS) return false;
  }
  return true;
}

// Try to match a GFM extended autolink at s[i]. prevOk says the preceding char
// allows it (start, whitespace, (, *, _, ~). afterChar is the char after the
// run in the full text (-1 if none), used for the email lookahead.
// Returns {href, text, start, end} or null.
function matchExtendedAutolink(s, i, afterChar) {
  const n = s.length;
  // www.
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    if (j >= n || !(isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === C_MINUS)) return null;
    let dots = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isAlnum(c) || c === C_MINUS || c === C_DOT || c === C_UNDER) { if (c === C_DOT) dots++; j++; }
      else break;
    }
    if (dots === 0) return null;
    // path: /... (no spaces, no < >)
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === C_LT || c === C_GT) break;
      j++;
    }
    const e = trimAutolink(s, i, j);
    if (e === i) return null;
    const text = s.slice(i, e);
    return { href: 'http://' + text, text, start: i, end: e };
  }
  // scheme://
  const m = /^(https?|ftp):\/\//i.exec(s.slice(i, i + 8));
  if (m) {
    let j = i + m[0].length;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c <= 32 || c === C_LT || c === C_GT) break;
      j++;
    }
    const e = trimAutolink(s, i, j);
    if (e === i) return null;
    const text = s.slice(i, e);
    return { href: text, text, start: i, end: e };
  }
  // email: local@domain.tld
  let j = i;
  const localStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === C_DOT || c === C_BANG || c === C_HASH || c === C_DOLLAR || c === C_PCT || c === C_AMP || c === C_APOS || c === C_STAR || c === C_PLUS || c === C_SLASH || c === C_EQ || c === C_QUEST || c === C_CARET || c === C_UNDER || c === C_BQUOTE || c === C_LBRACE || c === C_PIPE || c === C_RBRACE || c === C_TILDE || c === C_MINUS) j++;
    else break;
  }
  if (j > localStart && j < n && s.charCodeAt(j) === C_AT) {
    const at = j;
    j++;
    const domStart = j;
    let dots = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isAlnum(c) || c === C_MINUS) j++;
      else if (c === C_DOT) { dots++; j++; }
      else break;
    }
    // Strip trailing . and - from the domain (a.b-c_d@a.b. links a.b-c_d@a.b).
    let de = j;
    while (de > domStart && (s.charCodeAt(de - 1) === C_DOT || s.charCodeAt(de - 1) === C_MINUS)) de--;
    if (de > domStart && dots > 0) {
      const dom = s.slice(domStart, de);
      if (dom.charCodeAt(0) !== C_MINUS && dom.charCodeAt(0) !== C_DOT && dom.charCodeAt(dom.length - 1) !== C_MINUS && dom.charCodeAt(dom.length - 1) !== C_DOT) {
        // The char after the domain must not be a word char or -.
        // If the domain ends at the run boundary, check the char after the
        // run in the full text (afterChar).
        const nc = de < n ? s.charCodeAt(de) : afterChar;
        if (nc !== -1 && (isAlnum(nc) || nc === C_UNDER || nc === C_MINUS)) return null;
        let linkStart = i, hrefPrefix = 'mailto:';
        // mailto: / xmpp: + email links the whole thing including the scheme.
        if (i >= 7 && s.slice(i - 7, i).toLowerCase() === 'mailto:') { linkStart = i - 7; hrefPrefix = ''; }
        else if (i >= 5 && s.slice(i - 5, i).toLowerCase() === 'xmpp:') { linkStart = i - 5; hrefPrefix = ''; }
        let end = de;
        let text = s.slice(linkStart, end);
        // xmpp: may include one /segment of [A-Za-z0-9@.]+ after the email.
        if (hrefPrefix === '' && s.slice(linkStart, linkStart + 5).toLowerCase() === 'xmpp:' && end < n && s.charCodeAt(end) === C_SLASH) {
          let k = end + 1;
          while (k < n) {
            const c = s.charCodeAt(k);
            if (isAlnum(c) || c === C_AT || c === C_DOT) k++;
            else break;
          }
          if (k > end + 1) { end = k; text = s.slice(linkStart, end); }
        }
        return { href: hrefPrefix + text, text, start: linkStart, end };
      }
    }
  }
  return null;
}

// ---- inline node kinds ----
// 0 text {s} | 1 code {s} | 2 delim {ch,n,open,close} | 3 link {href,title,kids}
// 4 img {src,title,alt} | 5 html {s} | 6 br | 7 opener {image,dead,srcPos}

const SPECIAL = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 60, 38, 126, 10, 33]) SPECIAL[c] = 1;

// Try to complete a link at s[j] == ']'. nodes/openers are the scan state.
// Returns the index after the link, or -1 when no link forms.
// Is the source text s[start..end) balanced in brackets (depth never
// negative, ends at 0), skipping escaped chars and code spans?
function isBalancedLabel(s, start, end) {
  let depth = 0;
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === C_BSLASH && i + 1 < end) { i += 2; continue; }
    if (c === C_BQUOTE) {
      let r = i;
      while (r < end && s.charCodeAt(r) === C_BQUOTE) r++;
      const run = r - i;
      let j = r, close = -1;
      while (j < end) {
        if (s.charCodeAt(j) === C_BQUOTE) {
          let k = j;
          while (k < end && s.charCodeAt(k) === C_BQUOTE) k++;
          if (k - j === run) { close = j; break; }
          j = k;
        } else j++;
      }
      if (close === -1) { i = r; continue; }
      i = close + run;
      continue;
    }
    if (c === C_LBRACK) depth++;
    else if (c === C_RBRACK) {
      depth--;
      if (depth < 0) return false;
    }
    i++;
  }
  return depth === 0;
}

// Do these inline nodes contain a (real, non-autolink) link node?
// Autolinks demote to plain text inside link text and do not block it.
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 3 && !nd.auto) return true;
    if (nd.kids && containsLink(nd.kids)) return true;
  }
  return false;
}

// Demote autolink nodes to plain text (in place, recursively).
// Extended autolinks (bare URL/email) demote; angle autolinks (<...>) stay
// as nested links inside link text (marked keeps them).
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

// Try to form a link/image at the ']' at s[j]. Openers are tried from
// OUTERMOST to INNERMOST; the first opener whose text (between the opener
// and this ']') is balanced is the candidate. If a link forms but its text
// contains a link, it never forms and no other opener is tried. If the
// link doesn't parse, the next opener is tried. An inline link that fails
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
    if (next === C_LPAREN) {
      const r = parseInlineLink(s, j + 1, refs);
      if (r) {
        href = r.href; title = r.title; end = r.end; formed = true;
      } else {
        // fall back to the shortcut reference (cm-568)
        const label = normalizeLabel(s.slice(textStart, j));
        if (label !== '' && label.length <= 999) {
          const ref = refs.get(label);
          if (ref) { href = ref.href; title = ref.title; end = j + 1; formed = true; }
        }
      }
    } else if (next === C_LBRACK) {
      // [label] or [] (collapsed)
      let k = j + 2, depth = 0, ok = false;
      let labelEnd = -1;
      while (k < s.length) {
        const c = s.charCodeAt(k);
        if (c === C_BSLASH && k + 1 < s.length) { k += 2; continue; }
        if (c === C_LBRACK) depth++;
        else if (c === C_RBRACK) {
          if (depth === 0) { labelEnd = k; ok = true; break; }
          depth--;
        }
        k++;
      }
      if (ok) {
        let label;
        if (labelEnd === j + 2) {
          // collapsed: label is the link text
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
      // shortcut reference: label is the link text
      const label = normalizeLabel(s.slice(textStart, j));
      if (label !== '' && label.length <= 999) {
        const ref = refs.get(label);
        if (ref) { href = ref.href; title = ref.title; end = j + 1; formed = true; }
      }
    }
    if (!formed) continue; // try the next opener
    // A link whose text contains a (real) link never forms (and no other
    // opener is tried). Autolinks demote to plain text inside link text.
    if (!isImage && containsLink(nodes.slice(opIdx + 1))) return -1;
    // form the link: children are the nodes after the opener up to now
    const kids = nodes.splice(opIdx + 1);
    demoteAutoLinks(kids);
    // mark inner openers dead
    for (let k = oi + 1; k < openers.length; k++) openers[k].dead = true;
    openers.splice(oi, 1);
    nodes.splice(opIdx, 1); // remove the opener node
    if (isImage) {
      // Resolve emphasis in the description before computing the alt, so
      // e.g. ![foo *bar*] has alt "foo bar".
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

// Plain-text content of inline nodes (for image alt text).
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

// Resolve emphasis + strikethrough delimiters in one node list (recursive).
function resolveDelims(nodes) {
  // collect delim nodes in order
  const delims = [];
  for (const nd of nodes) {
    if (nd.t === 2) delims.push(nd);
    else if (nd.t === 3) resolveDelims(nd.kids);
  }
  if (delims.length < 2) return;
  // for each closer (in order), look back for an opener
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.close || closer.n === 0) continue;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      // A single-delimiter closer cannot jump over a consumed delimiter
      // that could both open and close, when that delimiter's own opener
      // (the delimiter just before it) was open-only. That is the
      // `*a **b**c*` / `**a *b*other* ...**` pattern (marked leaves the
      // outer emphasis literal), while `*foo**bar**baz*` (inner opener
      // also both) still forms the outer emphasis.
      if (closer.n === 1 && opener.n === 0 && opener.open && opener.close && closer.ch !== '~' && oi > 0) {
        const prev = delims[oi - 1];
        if (prev.n === 0 && prev.open && !prev.close && prev.ch === closer.ch) break;
      }
      if (opener.n === 0 || !opener.open || opener.ch !== closer.ch) continue;
      // rule of 3 for * and _
      if (closer.ch !== '~') {
        const sum = opener.n + closer.n;
        const openerBoth = opener.open && opener.close;
        const closerBoth = closer.open && closer.close;
        if (sum % 3 === 0 && (openerBoth || closerBoth) && !(opener.n % 3 === 0 && closer.n % 3 === 0)) continue;
      }
      // how many delimiters to use
      let use;
      if (closer.ch === '~') {
        if (opener.n === 1 && closer.n === 1) use = 1;
        else if (opener.n >= 2 && closer.n >= 2) use = 2;
        else continue; // a del opener and closer must match in count (1 or 2)
      } else if (opener.n >= 2 && closer.n >= 2) use = 2;
      else use = 1;
      // wrap the nodes between opener and closer
      const oiIdx = nodes.indexOf(opener);
      const ciIdx = nodes.indexOf(closer);
      if (oiIdx < 0 || ciIdx < 0 || ciIdx <= oiIdx) continue;
      const kids = nodes.slice(oiIdx + 1, ciIdx);
      const type = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const emNode = { t: 8, type, kids };
      opener.n -= use;
      closer.n -= use;
      const replacement = [];
      if (opener.n > 0) replacement.push(opener);
      replacement.push(emNode);
      if (closer.n > 0) replacement.push(closer);
      nodes.splice(oiIdx, ciIdx - oiIdx + 1, ...replacement);
      // after wrapping, the closer may still have delimiters left: retry it
      if (closer.n > 0) { ci--; }
      break;
    }
  }
}

// Render inline nodes to HTML.
function renderInline(nodes, out) {
  for (const nd of nodes) {
    switch (nd.t) {
      case 0: out.push(escapeSmart(nd.s)); break;
      case 1: out.push('<code>' + escapeRaw(nd.s) + '</code>'); break;
      case 2: out.push(nd.ch.repeat(nd.n)); break;
      case 3: {
        const href = cleanUrl(nd.href);
        if (href === null) { renderInline(nd.kids, out); break; }
        out.push('<a href="' + escapeSmart(href) + '"');
        if (nd.title !== null && nd.title !== undefined) out.push(' title="' + escapeSmart(nd.title) + '"');
        out.push('>');
        renderInline(nd.kids, out);
        out.push('</a>');
        break;
      }
      case 4: {
        const src = cleanUrl(nd.src);
        if (src === null) break;
        out.push('<img src="' + escapeSmart(src) + '" alt="' + escapeSmart(nd.alt) + '"');
        if (nd.title !== null && nd.title !== undefined) out.push(' title="' + escapeSmart(nd.title) + '"');
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

// Flush accumulated text run into nodes, splitting out extended autolinks.
// prevChar is the char code immediately before s[0] in the source (-1 = start).
function flushText(s, nodes, prevChar, fullText, runStart) {
  const end = s.length;
  if (end === 0) return;
  // The char after this run in the full text (for the email lookahead).
  const afterChar = fullText !== undefined && runStart + end < fullText.length ? fullText.charCodeAt(runStart + end) : -1;
  // fast path: no autolink candidates in this run
  if (s.indexOf('www.') === -1 && s.indexOf('://') === -1 && s.indexOf('@') === -1) {
    nodes.push({ t: 0, s });
    return;
  }
  // careful path: scan for autolink starts
  let i = 0;
  let segStart = 0;
  while (i < end) {
    const pc = i === 0 ? prevChar : s.charCodeAt(i - 1);
    const prevOk = pc === -1 || isWhitespace(pc) || pc === C_LPAREN || pc === C_STAR || pc === C_UNDER || pc === C_TILDE;
    // scheme:// links regardless of the preceding char (cm-602); www. and
    // email need prevOk. mailto:/xmpp: + email also links (the : is not
    // in prevOk, so check for the scheme prefix explicitly).
    const isScheme = (s.charCodeAt(i) === 104 || s.charCodeAt(i) === 72 || s.charCodeAt(i) === 102 || s.charCodeAt(i) === 70) &&
      /^(?:https?|ftp):\/\//i.test(s.slice(i, i + 8));
    let m = null;
    if (prevOk || isScheme) m = matchExtendedAutolink(s, i, afterChar);
    else if (i > 0 && s.charCodeAt(i - 1) === C_COLON) {
      const before = s.slice(0, i).toLowerCase();
      if (before.endsWith('mailto:') || before.endsWith('xmpp:')) m = matchExtendedAutolink(s, i, afterChar);
    }
    if (m) {
      const ls = m.start !== undefined ? m.start : i;
      if (ls > segStart) nodes.push({ t: 0, s: s.slice(segStart, ls) });
      // Mark as an autolink: inside link text it demotes to plain text.
      nodes.push({ t: 3, href: m.href, title: null, kids: [{ t: 0, s: m.text }], auto: true });
      i = m.end;
      segStart = i;
    } else {
      i++;
    }
  }
  if (segStart < end) nodes.push({ t: 0, s: s.slice(segStart, end) });
}

// Main inline parser: text -> HTML string.
function parseInline(text, refs) {
  const n = text.length;
  const nodes = [];
  const openers = [];
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
    // fast text run: accumulate until a special char
    if (c > 127 || !SPECIAL[c]) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d <= 127 && SPECIAL[d]) break;
        j++;
      }
      if (!buf) bufStart = i;
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    // A _, *, ~ or ` that is part of an email local part is plain text,
    // not a delimiter (otherwise the email would be split at the _).
    if ((c === C_UNDER || c === C_STAR || c === C_TILDE || c === C_BQUOTE) && isInEmail(text, i)) {
      if (!buf) bufStart = i;
      buf += text[i];
      i++;
      continue;
    }
    switch (c) {
      case C_LF: {
        // hard break: 2+ trailing spaces in buf
        let k = buf.length;
        while (k > 0 && buf.charCodeAt(k - 1) === C_SPACE) k--;
        if (buf.length - k >= 2) {
          buf = buf.slice(0, k);
          flushBuf();
          nodes.push({ t: 6 });
          // a hard break strips the leading whitespace of the next line
          i++;
          while (i < n && (text.charCodeAt(i) === C_SPACE || text.charCodeAt(i) === C_TAB)) i++;
        } else {
          if (!buf) bufStart = i;
          buf += '\n';
          i++;
        }
        break;
      }
      case C_BSLASH: {
        const nx = i + 1 < n ? text.charCodeAt(i + 1) : -1;
        if (nx === C_LF) {
          flushBuf();
          nodes.push({ t: 6 });
          i += 2;
          // a hard break strips the leading whitespace of the next line
          while (i < n && (text.charCodeAt(i) === C_SPACE || text.charCodeAt(i) === C_TAB)) i++;
        } else if (nx >= 0 && isPunct(nx)) {
          // An escaped & must render as &amp; (it is not an entity start).
          if (!buf) bufStart = i + 1;
          buf += nx === C_AMP ? '&amp;' : text[i + 1];
          i += 2;
        } else {
          if (!buf) bufStart = i;
          buf += '\\';
          i++;
        }
        break;
      }
      case C_BQUOTE: {
        let r = i;
        while (r < n && text.charCodeAt(r) === C_BQUOTE) r++;
        const run = r - i;
        // find a closing run of exactly `run` backticks
        let j = r, close = -1;
        while (j < n) {
          if (text.charCodeAt(j) === C_BQUOTE) {
            let k = j;
            while (k < n && text.charCodeAt(k) === C_BQUOTE) k++;
            if (k - j === run) { close = j; break; }
            j = k;
          } else j++;
        }
        if (close === -1) {
          if (!buf) bufStart = i;
          buf += '`'.repeat(run);
          i = r;
        } else {
          // Newlines become spaces FIRST, then the strip-one-space rule applies.
          let content = text.slice(r, close).replace(/\n/g, ' ');
          if (content.length >= 2 && content.charCodeAt(0) === C_SPACE && content.charCodeAt(content.length - 1) === C_SPACE && content.trim() !== '') {
            content = content.slice(1, -1);
          }
          flushBuf();
          nodes.push({ t: 1, s: content });
          i = close + run;
        }
        break;
      }
      case C_STAR:
      case C_UNDER: {
        let r = i;
        while (r < n && text.charCodeAt(r) === c) r++;
        const run = r - i;
        const [left, right] = flanking(text, i, run);
        let open, close;
        if (c === C_STAR) { open = left; close = right; }
        else {
          open = left && (!right || isPunct(i === 0 ? C_LF : text.charCodeAt(i - 1)));
          close = right && (!left || isPunct(i + run >= n ? C_LF : text.charCodeAt(i + run)));
        }
        flushBuf();
        nodes.push({ t: 2, ch: String.fromCharCode(c), n: run, open, close });
        i = r;
        break;
      }
      case C_TILDE: {
        let r = i;
        while (r < n && text.charCodeAt(r) === C_TILDE) r++;
        const run = r - i;
        // A del opener is 1 or 2 tildes followed by a non-space, non-tilde
        // char (a run of 3 tildes never forms a del).
        if (run >= 3) {
          if (!buf) bufStart = i;
          buf += '~'.repeat(run);
          i = r;
          break;
        }
        const [left, right] = flanking(text, i, run);
        flushBuf();
        nodes.push({ t: 2, ch: '~', n: run, open: left, close: right });
        i = r;
        break;
      }
      case C_LBRACK: {
        flushBuf();
        const node = { t: 7, image: false, dead: false, srcPos: i };
        nodes.push(node);
        openers.push({ node, image: false, dead: false, srcPos: i });
        i++;
        break;
      }
      case C_BANG: {
        if (i + 1 < n && text.charCodeAt(i + 1) === C_LBRACK) {
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
      case C_RBRACK: {
        flushBuf();
        const end = tryLink(text, i, nodes, openers, refs);
        if (end === -1) {
          if (!buf) bufStart = i;
          buf += ']';
          i++;
        } else i = end;
        break;
      }
      case C_LT: {
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
              nodes.push({ t: 5, s: text.slice(i, he) });
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
      case C_AMP: {
        const dec = decodeNumericEntity(text, i);
        if (dec) {
          if (!buf) bufStart = i;
          // A decoded & is not an entity start either.
          buf += dec[0] === '&' ? '&amp;' : dec[0];
          i = dec[1];
        } else if (isEntityLike(text, i)) {
          let j = i + 1;
          while (j < n && text.charCodeAt(j) !== C_SEMI) j++;
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

// ================= BLOCK PARSER =================
// A line is {s: string, lazy: boolean}. lazy = a blockquote lazy continuation
// (added to the open paragraph without block-start checks, except tables).

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== C_SPACE && c !== C_TAB) return false;
  }
  return true;
}

// Remove up to `cols` columns of leading indentation (tabs expand to next
// multiple of 4; a tab straddling the boundary becomes spaces).
function stripIndent(s, cols) {
  let i = 0, col = 0;
  const n = s.length;
  while (i < n && col < cols) {
    const c = s.charCodeAt(i);
    if (c === C_SPACE) { col++; i++; }
    else if (c === C_TAB) {
      const next = col + (4 - (col % 4));
      if (next <= cols) { col = next; i++; }
      else return ' '.repeat(next - cols) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function matchAtx(s, ci) {
  let k = ci, level = 0;
  while (s.charCodeAt(k) === C_HASH && level < 6) { k++; level++; }
  if (level === 0 || level > 6) return null;
  if (k < s.length) {
    const c = s.charCodeAt(k);
    if (c !== C_SPACE && c !== C_TAB) return null;
  }
  let text = s.slice(k);
  let a = 0, b = text.length;
  while (a < b && isSpace(text.charCodeAt(a))) a++;
  while (b > a && isSpace(text.charCodeAt(b - 1))) b--;
  text = text.slice(a, b);
  if (text.length > 0 && text.charCodeAt(text.length - 1) === C_HASH) {
    let r = text.length;
    while (r > 0 && text.charCodeAt(r - 1) === C_HASH) r--;
    if (r === 0 || isSpace(text.charCodeAt(r - 1))) {
      text = text.slice(0, r);
      while (text.length > 0 && isSpace(text.charCodeAt(text.length - 1))) text = text.slice(0, -1);
    }
  }
  return { level, text };
}

function matchFence(s, ci) {
  const ch = s.charCodeAt(ci);
  let k = ci, len = 0;
  while (s.charCodeAt(k) === ch) { k++; len++; }
  if (len < 3) return null;
  const rest = s.slice(k);
  if (ch === C_BQUOTE && rest.indexOf('`') !== -1) return null;
  // first word of the info string (backslash escapes resolved)
  let p = 0;
  while (p < rest.length && (rest.charCodeAt(p) === C_SPACE || rest.charCodeAt(p) === C_TAB)) p++;
  let q = p;
  while (q < rest.length && rest.charCodeAt(q) !== C_SPACE && rest.charCodeAt(q) !== C_TAB) q++;
  return { ch, len, info: unescapeText(rest.slice(p, q)), indent: indentCols(s) };
}

function matchHr(s, ci) {
  const ch = s.charCodeAt(ci);
  if (ch !== C_STAR && ch !== C_MINUS && ch !== C_UNDER) return false;
  let count = 0;
  for (let i = ci; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== C_SPACE && c !== C_TAB) return false;
  }
  return count >= 3;
}

function matchSetext(s, ci) {
  const ch = s.charCodeAt(ci);
  if (ch !== C_EQ && ch !== C_MINUS) return 0;
  // a setext underline is a run of the same char + optional trailing spaces
  // (no spaces between the chars: "= =" and "--- -" are not underlines)
  let i = ci;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  while (i < s.length && (s.charCodeAt(i) === C_SPACE || s.charCodeAt(i) === C_TAB)) i++;
  if (i < s.length) return 0;
  return ch === C_EQ ? 1 : 2;
}

function matchHtmlBlockStart(s, ci) {
  if (s.charCodeAt(ci) !== C_LT) return null;
  const rest = s.slice(ci + 1);
  const m1 = /^(script|pre|style|textarea)([\s>]|$)/i.exec(rest);
  if (m1) return { end: '</' + m1[1].toLowerCase() + '>' };
  if (rest.startsWith('!--')) return { end: '-->' };
  if (rest.charCodeAt(0) === 63) return { end: '?>' }; // <?
  if (rest.charCodeAt(0) === C_BANG && rest.length > 1 && isAlpha(rest.charCodeAt(1))) return { end: '>' }; // <!A
  if (rest.startsWith('![CDATA[')) return { end: ']]>' };
  const m6 = /^\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { end: 'blank' };
  return null;
}

function matchHtmlBlock7(s, ci) {
  if (s.charCodeAt(ci) !== C_LT) return false;
  const end = matchHtmlTag(s, ci);
  if (end === -1) return false;
  for (let k = end; k < s.length; k++) {
    if (!isSpace(s.charCodeAt(k))) return false;
  }
  return true;
}

// List marker: returns {ordered, delim, num, indent, contentIndent, empty} or null.
function matchListMarker(s, ci, ind) {
  if (ind > 3) return null;
  const c = s.charCodeAt(ci);
  let ordered = false, delim = '', num = 0, markerEnd = 0;
  if (c === C_MINUS || c === C_PLUS || c === C_STAR) {
    delim = String.fromCharCode(c);
    markerEnd = ci + 1;
  } else if (isDigit(c)) {
    let k = ci, n = 0;
    while (k < s.length && isDigit(s.charCodeAt(k)) && k - ci < 9) { n = n * 10 + (s.charCodeAt(k) - 48); k++; }
    if (k - ci > 9 || k >= s.length) return null;
    const d = s.charCodeAt(k);
    if (d !== C_DOT && d !== C_RPAREN) return null;
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
  if (nc !== C_SPACE && nc !== C_TAB) return null;
  // Expand the whitespace after the marker (starting at the marker's end
  // column), then measure it in columns.
  const after = expandLeadingTabs(s.slice(markerEnd), markerEndCol);
  let sp = 0;
  while (sp < after.length && after.charCodeAt(sp) === C_SPACE) sp++;
  const rest = after.slice(sp);
  if (rest.length === 0) {
    return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + 1, empty: true, content: '' };
  }
  if (sp >= 5) return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + 1, empty: false, content: after.slice(1) };
  return { ordered, delim, num, indent: ind, contentIndent: markerEndCol + sp, empty: false, content: rest };
}

// Table delimiter row: returns the align array or null.
function matchTableDelimiter(s) {
  const ind = indentCols(s);
  if (ind > 3) return null;
  let str = s.slice(idxOfCol(s, ind));
  let e = str.length;
  while (e > 0 && isSpace(str.charCodeAt(e - 1))) e--;
  str = str.slice(0, e);
  if (str.indexOf('|') === -1) return null;
  if (str.charCodeAt(0) === C_PIPE) str = str.slice(1);
  if (str.length && str.charCodeAt(str.length - 1) === C_PIPE) str = str.slice(0, -1);
  if (!str) return null;
  const cells = str.split('|');
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c.charCodeAt(0) === C_COLON ? (c.charCodeAt(c.length - 1) === C_COLON ? 'center' : 'left') : (c.charCodeAt(c.length - 1) === C_COLON ? 'right' : null));
  }
  return aligns;
}

// Split a table row into cells (respecting \| escapes and outer pipes).
function splitRow(s) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = s.length;
  let bs = 0;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  if (i < n && s.charCodeAt(i) === C_PIPE) i++;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === C_BSLASH) { cur += '\\'; bs++; }
    else if (c === C_PIPE) {
      if (bs % 2 === 0) { cells.push(cur); cur = ''; bs = 0; }
      else { cur = cur.slice(0, -1) + '|'; bs = 0; } // \| -> | (backslash consumed by the table split)
    }
    else { cur += s[i]; bs = 0; }
  }
  cells.push(cur);
  let t = n;
  while (t > 0 && isSpace(s.charCodeAt(t - 1))) t--;
  if (t > 0 && s.charCodeAt(t - 1) === C_PIPE) {
    let b = 0, k = t - 2;
    while (k >= 0 && s.charCodeAt(k) === C_BSLASH) { b++; k--; }
    if (b % 2 === 0) cells.pop();
  }
  return cells.map(c => c.trim());
}

// Parse a title starting at s[p] ('"' or "'" or '('). Returns {title, end} or null.
function parseTitleAt(s, p) {
  const c = s.charCodeAt(p);
  let close;
  if (c === C_QUOT) close = C_QUOT;
  else if (c === C_APOS) close = C_APOS;
  else if (c === C_LPAREN) close = C_RPAREN;
  else return null;
  let q = p + 1;
  while (q < s.length) {
    const d = s.charCodeAt(q);
    if (d === C_BSLASH && q + 1 < s.length) { q += 2; continue; }
    if (d === close) return { title: unescapeText(s.slice(p + 1, q)), end: q + 1 };
    if (close === C_RPAREN && (d === C_LPAREN || d === C_LF)) return null;
    q++;
  }
  return null;
}

// Parse a link reference definition at lines[i]. Returns {label, href, title, next} or null.
// A def may span lines: the label may contain newlines, the dest may be on
// the next line (at most one \n after the colon), and a quoted title may
// span lines or sit on the next line. A title must be preceded by whitespace.
function parseRefDef(lines, i) {
  const line = lines[i].s;
  const ind = indentCols(line);
  if (ind > 3) return null;
  let p = idxOfCol(line, ind);
  if (line.charCodeAt(p) !== C_LBRACK) return null;
  // Joined view of the next few lines (a def spans at most a few lines).
  const K = Math.min(12, lines.length - i);
  let t = '';
  for (let k = 0; k < K; k++) {
    if (k > 0) t += '\n';
    t += lines[i + k].s;
  }
  let q = p + 1; // after '['
  // label: until ']', skipping escaped chars; may contain newlines; no '['
  const labelStart = q;
  while (q < t.length) {
    const c = t.charCodeAt(q);
    if (c === C_BSLASH && q + 1 < t.length) { q += 2; continue; }
    if (c === C_LBRACK) return null;
    if (c === C_RBRACK) break;
    q++;
  }
  if (q >= t.length || t.charCodeAt(q) !== C_RBRACK) return null;
  const label = normalizeLabel(t.slice(labelStart, q));
  if (label === '' || label.length > 999) return null;
  q++;
  if (t.charCodeAt(q) !== C_COLON) return null;
  q++;
  // spaces, then at most one newline + spaces/tabs, before the dest
  while (q < t.length && (t.charCodeAt(q) === C_SPACE || t.charCodeAt(q) === C_TAB)) q++;
  if (q < t.length && t.charCodeAt(q) === C_LF) {
    q++;
    while (q < t.length && (t.charCodeAt(q) === C_SPACE || t.charCodeAt(q) === C_TAB)) q++;
  }
  if (q >= t.length) return null;
  // dest
  let href;
  if (t.charCodeAt(q) === C_LT) {
    let r = q + 1, closed = false;
    while (r < t.length) {
      const c = t.charCodeAt(r);
      if (c === C_LF) break; // angle dest cannot span lines
      if (c === C_BSLASH && r + 1 < t.length) { r += 2; continue; }
      if (c === C_GT) { closed = true; break; }
      if (c === C_LT) return null;
      r++;
    }
    if (!closed) return null;
    href = unescapeText(t.slice(q + 1, r));
    q = r + 1;
  } else {
    let r = q, depth = 0;
    while (r < t.length) {
      const c = t.charCodeAt(r);
      if (c === C_SPACE || c === C_TAB || c === C_LF) break;
      if (c === C_BSLASH && r + 1 < t.length) { r += 2; continue; }
      if (c === C_LPAREN) depth++;
      else if (c === C_RPAREN) { depth--; if (depth < 0) break; }
      r++;
    }
    if (r === q) return null;
    href = unescapeText(t.slice(q, r));
    q = r;
  }
  // After the dest, try to find a title. A title must be preceded by
  // whitespace (a space on this line, or a newline to the next line).
  // A title opener directly after the dest is not a title: the def fails.
  let title = null;
  let titleEnd = -1;
  let titleNextLine = false;
  let sp = q;
  while (sp < t.length && (t.charCodeAt(sp) === C_SPACE || t.charCodeAt(sp) === C_TAB)) sp++;
  const afterSp = sp < t.length ? t.charCodeAt(sp) : -1;
  if (afterSp === C_QUOT || afterSp === C_APOS || afterSp === C_LPAREN) {
    // title on this line (must be preceded by at least one space)
    if (sp === q) return null;
    const tt = parseTitleAt(t, sp);
    if (!tt) return null;
    title = tt.title; titleEnd = tt.end;
  } else if (afterSp === C_LF) {
    // try a title on the next line (a failed title falls back to no title)
    let nl = sp + 1;
    while (nl < t.length && (t.charCodeAt(nl) === C_SPACE || t.charCodeAt(nl) === C_TAB)) nl++;
    const c2 = nl < t.length ? t.charCodeAt(nl) : -1;
    if (c2 === C_QUOT || c2 === C_APOS || c2 === C_LPAREN) {
      const tt = parseTitleAt(t, nl);
      if (tt) { title = tt.title; titleEnd = tt.end; titleNextLine = true; }
    }
  } else if (sp >= t.length) {
    // no title; def ends at the dest
  } else {
    return null; // not a title opener and not end of line
  }
  // After the title (or dest), only spaces to end of line.
  let e = title !== null ? titleEnd : sp;
  while (e < t.length && (t.charCodeAt(e) === C_SPACE || t.charCodeAt(e) === C_TAB)) e++;
  if (e < t.length && t.charCodeAt(e) !== C_LF) {
    if (title !== null && titleNextLine) {
      // A next-line title with trailing content: fall back to no title.
      title = null;
      e = sp; // sp is at the \n after the dest
    } else {
      return null;
    }
  }
  const end = e;
  // Lines consumed = 1 + newlines before end.
  let linesConsumed = 1;
  for (let k = 0; k < end; k++) if (t.charCodeAt(k) === C_LF) linesConsumed++;
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
// Returns the block or null (paragraph was only ref defs).
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

function parseFenced(lines, i, fence, blocks) {
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j].s;
    const li = indentCols(line);
    const ci = idxOfCol(line, li);
    if (li <= 3 && line.charCodeAt(ci) === fence.ch) {
      let k = ci, len = 0;
      while (line.charCodeAt(k) === fence.ch) { k++; len++; }
      if (len >= fence.len) {
        let ok = true;
        for (let m = k; m < line.length; m++) { if (!isSpace(line.charCodeAt(m))) { ok = false; break; } }
        if (ok) { j++; break; }
      }
    }
    content.push(stripIndent(line, fence.indent));
    j++;
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

function parseIndentedCode(lines, i, blocks) {
  const content = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j].s;
    if (isBlankStr(line)) { content.push(stripIndent(line, 4)); j++; continue; }
    if (indentCols(line) >= 4) { content.push(stripIndent(line, 4)); j++; continue; }
    break;
  }
  while (content.length && content[content.length - 1].trim() === '') content.pop();
  blocks.push({ type: 'code', lang: '', text: content.length ? content.join('\n') + '\n' : '' });
  return j;
}

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
  // Trailing newline (marked's ge() rule): a block followed by a blank line has
  // none; followed by a non-blank line it keeps one; at the end of its container
  // it keeps one only at the top level when the document ends with a newline.
  let trailing = '\n';
  if (j < lines.length) trailing = isBlankStr(lines[j].s) ? '' : '\n';
  else trailing = (isTop && _DOC_ENDS_NL) ? '\n' : '';
  blocks.push({ type: 'html', text: content.join('\n') + trailing });
  return j;
}

function parseTable(lines, i, headerLine, aligns, blocks, refs) {
  const headerCells = splitRow(headerLine);
  const ncols = aligns.length;
  while (headerCells.length < ncols) headerCells.push('');
  headerCells.length = ncols;
  const rows = [];
  let j = i + 1;
  // A body row must be paragraph text; a line starting a new block
  // (e.g. a blockquote) ends the table.
  while (j < lines.length && !isBlankStr(lines[j].s) && isParaLine(lines[j].s)) {
    const cells = splitRow(lines[j].s);
    while (cells.length < ncols) cells.push('');
    cells.length = ncols;
    rows.push(cells);
    j++;
  }
  blocks.push({ type: 'table', header: headerCells, aligns, rows });
  return j;
}

// Could the last line of a container hold an open paragraph, so a lazy
// (unindented) line can continue it? Paragraph text, a blockquote line, or a
// list marker whose content is paragraph text / a blockquote line.
function lastLineContinuable(s) {
  if (isParaLine(s)) return true;
  if (/^\s*>/.test(s)) return true;
  const ind = indentCols(s);
  const m = matchListMarker(s, idxOfCol(s, ind), ind);
  if (m && !m.empty) {
    if (isParaLine(m.content) || /^\s*>/.test(m.content)) return true;
  }
  return false;
}

// Could this line be paragraph text (not a block starter, indent <= 3)?
function isParaLine(s) {
  if (isBlankStr(s)) return false;
  const ind = indentCols(s);
  if (ind > 3) return false;
  const ci = idxOfCol(s, ind);
  const c0 = s.charCodeAt(ci);
  if (c0 === C_HASH && matchAtx(s, ci)) return false;
  if ((c0 === C_BQUOTE || c0 === C_TILDE) && matchFence(s, ci)) return false;
  if (c0 === C_LT && matchHtmlBlockStart(s, ci)) return false;
  if (c0 === C_GT) return false;
  if (matchListMarker(s, ci, ind)) return false;
  if ((c0 === C_STAR || c0 === C_MINUS || c0 === C_UNDER) && matchHr(s, ci)) return false;
  if ((c0 === C_EQ || c0 === C_MINUS) && matchSetext(s, ci)) return false;
  return true;
}

// Is this line a paragraph continuation (lazy blockquote line)?
function isLazyLine(s) {
  if (isBlankStr(s)) return false;
  const ind = indentCols(s);
  if (ind > 3) return true;
  const ci = idxOfCol(s, ind);
  const c0 = s.charCodeAt(ci);
  if (c0 === C_HASH && matchAtx(s, ci)) return false;
  if ((c0 === C_BQUOTE || c0 === C_TILDE) && matchFence(s, ci)) return false;
  if (c0 === C_LT && matchHtmlBlockStart(s, ci)) return false;
  if (c0 === C_GT) return false;
  if (matchListMarker(s, ci, ind)) return false;
  if ((c0 === C_STAR || c0 === C_MINUS || c0 === C_UNDER) && matchHr(s, ci)) return false;
  return true;
}

// Are these lines (in order) ending inside a fenced code block?
// Scans for fence openers/closers (``` or ~~~, indent <= 3).
function endsInFence(lines) {
  let fenceCh = 0, fenceLen = 0;
  for (const ln of lines) {
    const s = ln.s;
    if (fenceCh) {
      const ind = indentCols(s);
      if (ind <= 3) {
        const ci = idxOfCol(s, ind);
        if (s.charCodeAt(ci) === fenceCh) {
          let k = ci, len = 0;
          while (s.charCodeAt(k) === fenceCh) { k++; len++; }
          if (len >= fenceLen) {
            let ok = true;
            for (let m = k; m < s.length; m++) { if (!isSpace(s.charCodeAt(m))) { ok = false; break; } }
            if (ok) { fenceCh = 0; fenceLen = 0; }
          }
        }
      }
      continue;
    }
    const ind = indentCols(s);
    if (ind > 3) continue;
    const ci = idxOfCol(s, ind);
    const c0 = s.charCodeAt(ci);
    if (c0 === C_BQUOTE || c0 === C_TILDE) {
      let k = ci, len = 0;
      while (s.charCodeAt(k) === c0) { k++; len++; }
      if (len >= 3) { fenceCh = c0; fenceLen = len; }
    }
  }
  return fenceCh !== 0;
}

function parseBlockquote(lines, i, blocks, refs, inListItem) {
  const inner = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j].s;
    const ind = indentCols(line);
    if (ind <= 3) {
      const ci = idxOfCol(line, ind);
      if (line.charCodeAt(ci) === C_GT) {
        // Expand the whitespace after > (starting at the column after >),
        // then remove 1 column (the space after >).
        const afterGt = line.slice(ci + 1);
        const expanded = expandLeadingTabs(afterGt, ind + 1);
        const content = expanded.charCodeAt(0) === C_SPACE ? expanded.slice(1) : expanded;
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

function parseList(lines, i, blocks, refs) {
  const firstLine = lines[i].s;
  const first = matchListMarker(firstLine, idxOfCol(firstLine, indentCols(firstLine)), indentCols(firstLine));
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
    const last = cur.lines[cur.lines.length - 1].s;
    if (isBlankStr(last)) return false;
    if (isParaLine(last)) return true;
    // a blockquote line can continue (its paragraph is open)
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
    const ind = indentCols(line);
    const ci = idxOfCol(line, ind);
    const c0 = line.charCodeAt(ci);
    // An hr at a possible sibling indent ends the list.
    if (ind <= Math.min(3, curIndent - 1) && (c0 === C_STAR || c0 === C_MINUS || c0 === C_UNDER) && matchHr(line, ci)) {
      break;
    }
    const m = matchListMarker(line, ci, ind);
    if (m && m.ordered === ordered && m.delim === delim) {
      // New sibling iff the marker indent is <= min(3, R-1) of the current item.
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
      // A different list type/delim at a sibling indent ends this list.
      // At a deeper indent it is a nested list inside the current item.
      break;
    }
    if (!cur) break;
    // An empty item followed by a blank line is closed.
    if (curIsEmpty() && (cur.sawBlank || pending.length > 0)) break;
    // Lazy continuation (from a blockquote): leading whitespace is removed.
    // Not after a blank line.
    if (ln.lazy && lastContinuable() && pending.length === 0) {
      if (/^ {0,3}(?:=+|-+) *$/.test(line)) {
        cur.lines.push({ s: '    ' + line.replace(/^ {0,3}/, ''), lazy: true });
      } else {
        cur.lines.push({ s: line.replace(/^[ \t]+/, ''), lazy: true });
      }
      j++;
      continue;
    }
    // Indented to the content indent: part of the item (expand, strip R cols).
    if (ind >= curIndent) {
      if (pending.length) { cur.lines.push(...pending); cur.sawBlank = true; pending = []; }
      cur.lines.push({ s: stripColsExpanded(line, curIndent), lazy: false });
      j++;
      continue;
    }
    // Unindented line: lazy paragraph continuation of the item.
    // Not after a blank line.
    if (lastContinuable() && pending.length === 0) {
      if (/^ {0,3}(?:=+|-+) *$/.test(line)) {
        cur.lines.push({ s: '    ' + line.replace(/^ {0,3}/, ''), lazy: true });
      } else {
        cur.lines.push({ s: line.replace(/^[ \t]+/, ''), lazy: true });
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
      if (t.length >= 3 && t.charCodeAt(0) === C_LBRACK && t.charCodeAt(2) === C_RBRACK &&
          (t.charCodeAt(1) === C_SPACE || t.charCodeAt(1) === 120 || t.charCodeAt(1) === 88) &&
          (t.length === 3 || isWhitespace(t.charCodeAt(3)))) {
        itemBlocks[0].task = t.charCodeAt(1) === C_SPACE ? 'unchecked' : 'checked';
        itemBlocks[0].text = t.slice(3);
      }
    }
    // Loose if the item directly contains two blocks separated by a blank line.
    if (itemBlocks.loose) loose = true;
    // Loose if a (source) blank line separates this item from the next.
    // An empty item's own empty content is not a blank-line separator.
    if (k < items.length - 1 && items[k].sawBlank && ls.length > 0 && isBlankStr(ls[ls.length - 1].s)) loose = true;
    parsed.push(itemBlocks);
  }
  blocks.push({ type: 'list', ordered, start: ordered ? first.num : 0, loose, items: parsed });
  // Rewind past buffered blank lines so the caller re-processes them.
  return j - pending.length;
}

function parseBlockLines(lines, refs, isTop, inListItem) {
  const blocks = [];
  // Looseness: a blank line between two direct blocks makes this level loose.
  // (Blank lines inside a nested list/code block do not count.)
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
      // A trailing spaces-only line (the last line, no following newline) is
      // paragraph content, not a blank line.
      if (para.length > 0 && i === n - 1 && line.length > 0) {
        para.push(ln);
        i++;
        continue;
      }
      flushPara(); sawBlank = true; i++; continue;
    }
    const ind = indentCols(line);
    const ci = idxOfCol(line, ind);
    const c0 = line.charCodeAt(ci);
    if (ln.lazy) {
      // lazy continuation: only the table check applies
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
        } else if (indentCols(line) >= 4) {
          pushLine = { s: stripIndent(line, 4), lazy: true };
        }
        para.push(pushLine);
        i++;
        continue;
      }
      // no paragraph open: fall through to normal checks
    }
    if (ind >= 4) {
      if (para.length === 0) { noteBlock(); i = parseIndentedCode(lines, i, blocks); continue; }
      para.push(ln);
      i++;
      continue;
    }
    // setext heading (only when a paragraph is open)
    if (para.length > 0 && (c0 === C_EQ || c0 === C_MINUS)) {
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
    // ATX heading
    if (c0 === C_HASH) {
      const h = matchAtx(line, ci);
      if (h) { flushPara(); noteBlock(); blocks.push({ type: 'heading', level: h.level, text: h.text }); i++; continue; }
    }
    // fenced code
    if (c0 === C_BQUOTE || c0 === C_TILDE) {
      const f = matchFence(line, ci);
      if (f) { flushPara(); noteBlock(); i = parseFenced(lines, i, f, blocks); continue; }
    }
    // HTML block types 1-6
    if (c0 === C_LT) {
      const hb = matchHtmlBlockStart(line, ci);
      if (hb) { flushPara(); noteBlock(); i = parseHtmlBlock(lines, i, hb, blocks, isTop); continue; }
    }
    // blockquote
    if (c0 === C_GT) {
      flushPara(); noteBlock();
      i = parseBlockquote(lines, i, blocks, refs, inListItem);
      continue;
    }
    // thematic break (before list: "- - -" and "* * *" are hr, not lists)
    if (c0 === C_STAR || c0 === C_MINUS || c0 === C_UNDER) {
      if (matchHr(line, ci)) { flushPara(); noteBlock(); blocks.push({ type: 'hr' }); i++; continue; }
    }
    // list
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
    // table delimiter (only when a paragraph is open)
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
    // HTML block type 7 (only when no paragraph is open)
    if (para.length === 0 && c0 === C_LT) {
      if (matchHtmlBlock7(line, ci)) { i = parseHtmlBlock(lines, i, { end: 'blank' }, blocks, isTop); continue; }
    }
    // paragraph line
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

// Render blocks. `tight` = inside a tight list item (paragraphs render bare).
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
        out.push('<pre><code' + (b.lang ? ' class="language-' + escapeSmart(b.lang) + '"' : '') + '>' + escapeRaw(b.text) + '</code></pre>\n');
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

// Does the source document end with a newline? (for the HTML-block trailing-\n rule)
let _DOC_ENDS_NL = false;

export function parse(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  _DOC_ENDS_NL = text.endsWith('\n');
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
