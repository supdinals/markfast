// markfast — a Markdown to HTML renderer that produces, for every input,
// exactly the HTML that marked 18.1.3 renders with its default options
// (GFM on, breaks off, pedantic off), while spending less CPU doing it.
//
// The grammar tables below follow the CommonMark 0.31.2 / GFM 0.29 rules as
// implemented by marked (MIT, Copyright (c) 2018-2026 MarkedJS and
// Copyright (c) 2011-2018 Christopher Jeffrey — see the NOTICE note in this
// repository). The engine itself is a fresh implementation: block tokens are
// produced in one pass, inline runs are rendered straight to HTML strings
// (no intermediate inline token objects), and the hot loops dispatch on the
// first character instead of trying every rule at every position.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeReplacement = (ch) => ESCAPES[ch];

// Escape &, <, >, " and ' when `encode` is set. Without it, an & that already
// begins a character reference is left alone.
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
export function escapeHtml(html, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(html)) return html.replace(ESCAPE_REPLACE, escapeReplacement);
  } else if (ESCAPE_TEST_NO_ENCODE.test(html)) {
    return html.replace(ESCAPE_REPLACE_NO_ENCODE, escapeReplacement);
  }
  return html;
}


const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Turn numeric character references into the characters they name. A bare &
// that is not part of one is escaped so a decoded character can never fuse
// with its neighbours into a new reference.
export function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// encodeURI the href the way marked does; a href that cannot be encoded
// makes the link render as plain text (null).
const URL_NEEDS_WORK = /[% "<>\\^`{|}\[\]\x00-\x1F\x7F-\uFFFF]/;
export function cleanUrl(href) {
  // Most destinations are plain ASCII with no %25 to collapse: encodeURI
  // would return them unchanged, so skip both calls.
  if (!URL_NEEDS_WORK.test(href)) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Remove a suffix made only of `c` (or, inverted, of characters other than
// `c`). Written as a scan because /c*$/ is a ReDoS risk.
export function rtrim(str, c, invert) {
  const len = str.length;
  if (len === 0) return '';
  let suffix = 0;
  while (suffix < len) {
    const ch = str.charAt(len - suffix - 1);
    if (invert ? ch !== c : ch === c) suffix++;
    else break;
  }
  return str.slice(0, len - suffix);
}

// Drop trailing blank lines beyond the first one.
export function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Fold a link label to its lookup key: collapse whitespace runs, then a
// Unicode case fold (lower -> upper -> lower reaches folds like SS -> ß
// that a plain toLowerCase misses).
export function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes the pair opened before `str`, honouring
// backslash escapes. -1: no closer and none missing; -2: openers left over.
export function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') i++;
    else if (ch === pair[0]) depth++;
    else if (ch === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand the tabs of one line to spaces, tab stops every 4 columns, counting
// from column `indent`.
export function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into trimmed cells. Unescaped pipes gain a leading space
// first so an escaped \| stays inside its cell.
export function splitCells(row, count) {
  const spaced = row.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let i = offset;
    while (--i >= 0 && str[i] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Code units in the first code point of `s` (1, or 2 for an astral pair).
function firstCodePointLength(s) {
  const c = s.charCodeAt(0);
  if (c < 0xd800 || c > 0xdbff || s.length < 2) return 1;
  const next = s.charCodeAt(1);
  return next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
}

// Length in code points, with an ASCII fast path: delimiter runs and most
// matches are pure ASCII, where code units and code points agree.
function codePointLength(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) return [...s].length;
  }
  return s.length;
}

// Scan a masked inline source once and note the last run of '*', '_' and '~'
// that could close emphasis, strong or strikethrough: a run whose preceding
// character is not ASCII whitespace (the start of the string counts as a
// line break, hence a valid predecessor).
export function scanCloserHints(src) {
  const hints = { '*': -1, _: -1, '~': -1 };
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      hints[ch] = i;
    }
    i = j - 1;
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Grammar tables (GFM flavour: the only flavour parse() ever runs)
// ---------------------------------------------------------------------------

// Indent-sensitive one-line probes used while scanning list items. marked
// caches four variants; the variant is chosen by clamping indent-1 to 0..3
// and the pattern itself is built from that clamped number.
function indentProbe(build) {
  const cache = [];
  return (indent) => {
    const slot = Math.max(0, Math.min(3, indent - 1));
    let re = cache[slot];
    if (!re) {
      re = build(slot);
      cache[slot] = re;
    }
    return re;
  };
}
const nextBulletProbe = indentProbe((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrProbe = indentProbe((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginProbe = indentProbe((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginProbe = indentProbe((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const blockquoteBeginProbe = indentProbe((n) => new RegExp(`^ {0,${n}}>`));
const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const htmlBeginProbe = indentProbe((n) => new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));

const RE = {
  // block level
  newline: /^(?:[ \t]*(?:\n|$))+/,
  blockCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?!(?: *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[))).*(?:\n|$))*)\n*|$)/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?!(?: *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[))).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  blockText: /^[^\n]+/,
  // inline level
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  inlineCode: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
  inlineText: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\\|}~-]+@))))/,
  // shared one-off patterns
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  bqStart: /^ {0,3}>/,
  bqSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  bqSetextStrip: /^ {0,3}>[ \t]?/gm,
  bqMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  notSpaceStart: /^\S*/,
};
// ---------------------------------------------------------------------------
// Parse context: everything one parse() call shares. A fresh one is made per
// call, so nothing can leak from one case into the next.
// ---------------------------------------------------------------------------

function newContext() {
  return {
    links: Object.create(null), // normalized label -> { href, title }
    queue: [],                  // inline jobs, in the order blocks created them
    tokens: null,               // the top-level token list (holds .links too)
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Queue one inline run to be rendered after the whole block pass (link
// reference definitions anywhere in the document must be known first).
function queueInline(ctx, src) {
  const job = { src, html: '' };
  ctx.queue.push(job);
  return job;
}

function infiniteLoop(byte) {
  throw new Error('Infinite loop on byte: ' + byte);
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the remaining source and returns a token or
// undefined; the caller advances by token.raw.length.
// ---------------------------------------------------------------------------

function codeToken(ctx, src) {
  const cap = RE.blockCode.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return { type: 'code', raw, text: raw.replace(RE.codeRemoveIndent, '') };
}

function fencesToken(ctx, src) {
  const cap = RE.fences.exec(src);
  if (!cap) return undefined;
  const raw = cap[0];
  let text = cap[3] || '';
  // A fenced block indented as a whole has that indent stripped per line,
  // each line losing no more than it has.
  const fenceIndent = raw.match(RE.indentCodeCompensation);
  if (fenceIndent) {
    const indent = fenceIndent[1];
    text = text.split('\n').map((line) => {
      const own = line.match(RE.beginningSpace);
      if (!own) return line;
      return line.slice(Math.min(own[0].length, indent.length));
    }).join('\n');
  }
  return {
    type: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(RE.anyPunctuation, '$1') : cap[2],
    text,
  };
}

function headingToken(ctx, src) {
  const cap = RE.heading.exec(src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  // A closing run of #s counts only when a space or tab precedes it.
  if (RE.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || RE.endingSpaceTab.test(trimmed)) text = trimmed.trim();
  }
  return {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[1].length,
    text,
    job: queueInline(ctx, text),
  };
}

function hrToken(ctx, src) {
  const cap = RE.hr.exec(src);
  if (!cap) return undefined;
  return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function blockquoteToken(ctx, src) {
  const cap = RE.blockquote.exec(src);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (RE.bqStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(RE.bqMarkerWs, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE.bqSetext, '\n    $1')
      .replace(RE.bqSetextStrip, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;

    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(ctx, currentText, tokens, true);
    ctx.top = savedTop;

    if (lines.length === 0) break;

    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr'
      || last?.type === 'html' || last?.type === 'table') {
      break;
    } else if (last?.type === 'blockquote') {
      const continuation = lines.join('\n');
      const newText = last.raw + '\n' + continuation.replace(RE.bqSetextStrip, '');
      const newToken = blockquoteToken(ctx, newText);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RE.bqStart.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const newText = last.raw + '\n' + lines.join('\n');
      const newToken = listToken(ctx, newText);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > last.raw.length
        ? newText.slice(last.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw += '\n' + consumed;
        text += '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { type: 'blockquote', raw, tokens, text };
}

function listToken(ctx, src) {
  let cap = RE.list.exec(src);
  if (!cap) return undefined;
  // Absolute offsets into src replace the shrinking-remainder slices: one
  // slice per item for the bullet probe, and lines read by index.
  let pos = 0;
  let bull = cap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRe = new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
  let endsWithBlankLine = false;

  while (pos < src.length) {
    let endEarly = false;
    let itemContents = '';
    const rest = src.slice(pos);
    if (!(cap = itemRe.exec(rest))) break;
    if (RE.hr.test(rest)) break; // the bullet was actually a thematic break

    const itemStart = pos;
    pos += cap[0].length;

    const firstNl = cap[2].indexOf('\n');
    const firstLine = firstNl === -1 ? cap[2] : cap[2].slice(0, firstNl);
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    const nextNl = src.indexOf('\n', pos);
    let nextLine = nextNl === -1 ? src.slice(pos) : src.slice(pos, nextNl);
    let blankLine = isBlankLine(line);

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = firstNonSpaceIndex(line);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && RE.blankLine.test(nextLine)) {
      pos += nextLine.length + 1;
      endEarly = true;
    }

    if (!endEarly) {
      const nextBullet = nextBulletProbe(indent);
      const hrRe = hrProbe(indent);
      const fencesBegin = fencesBeginProbe(indent);
      const headingBegin = headingBeginProbe(indent);
      const htmlBegin = htmlBeginProbe(indent);
      const blockquoteBegin = blockquoteBeginProbe(indent);

      // The six "a new block starts here" probes all key off the first
      // content character after up to N spaces; a line starting with
      // anything else (a letter, say) starts none of them.
      const probeDepth = Math.max(0, Math.min(3, indent - 1));
      let linePending = null;
      while (pos < src.length) {
        const lineNl = src.indexOf('\n', pos);
        const rawLine = lineNl === -1 ? src.slice(pos) : src.slice(pos, lineNl);
        nextLine = rawLine;
        const nextLineNoTabs = nextLine.charCodeAt(0) === 32 || nextLine.charCodeAt(0) === 9
          ? nextLine.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws))
          : nextLine;

        let pi = 0;
        while (pi < probeDepth && nextLine.charCodeAt(pi) === 32) pi++;
        const pc = nextLine[pi];
        if (pc === '`' || pc === '~' || pc === '#' || pc === '<' || pc === '>'
          || pc === '*' || pc === '+' || pc === '-' || pc === '_' || (pc >= '0' && pc <= '9')) {
          if (fencesBegin.test(nextLine)) break;
          if (headingBegin.test(nextLine)) break;
          if (htmlBegin.test(nextLine)) break;
          if (blockquoteBegin.test(nextLine)) break;
          if (nextBullet.test(nextLine)) break;
          if (hrRe.test(nextLine)) break;
        }

        if (firstNonSpaceIndex(nextLineNoTabs) >= indent || isBlankLine(nextLine)) {
          itemContents += '\n' + nextLineNoTabs.slice(indent);
        } else {
          // The previous line, dedented, decides whether a lazy line can
          // continue the paragraph. It is sliced only here, where it is read.
          const prevLine = linePending === null ? line : linePending.slice(indent);
          if (blankLine) break;
          if (firstNonSpaceIndex(prevLine.replace(/\t/g, '    ')) >= 4) break;
          if (fencesBegin.test(prevLine)) break;
          if (headingBegin.test(prevLine)) break;
          if (htmlBegin.test(prevLine)) break;
          if (hrRe.test(prevLine)) break;

          // A lazy line that reads as a setext underline stays paragraph text.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && RE.lheading.test(prevLine + '\n' + nextLine);
          itemContents += '\n' + (setextContinuation
            ? '    ' + nextLineNoTabs.replace(/^ {0,3}/, '')
            : nextLine);
        }

        blankLine = isBlankLine(nextLine);
        pos += rawLine.length + 1;
        linePending = nextLineNoTabs;
      }
    }

    const raw = src.slice(itemStart, pos);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (endsWithDoubleBlank(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: RE.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  list.raw = src.slice(0, pos).trimEnd();

  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(ctx, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      if (spacers.length > 0 && spacers.some((t) => RE.anyLine.test(t.raw))) {
        list.loose = true;
      }
    }
  }

  // Task list checkboxes are placed once the list's looseness is final.
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(RE.listReplaceTask, '');
      first.raw = first.raw.replace(RE.listReplaceTask, '');
      first.text = first.text.replace(RE.listReplaceTask, '');
      for (let i = ctx.queue.length - 1; i >= 0; i--) {
        if (RE.listIsTask.test(ctx.queue[i].src)) {
          ctx.queue[i].src = ctx.queue[i].src.replace(RE.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = RE.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkbox = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
        item.checked = checkbox.checked;
        item.checkbox = checkbox;
        if (list.loose) {
          if (first && (first.type === 'paragraph' || first.type === 'text') && first.job) {
            first.prefix = checkbox;
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, job: null, prefix: checkbox, bare: true });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }

  return list;
}

function htmlToken(ctx, src) {
  const cap = RE.html.exec(src);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function defToken(ctx, src) {
  const cap = RE.def.exec(src);
  if (!cap) return undefined;
  // Outside angle brackets a destination holds only balanced parentheses.
  if (!/^</.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
  return {
    type: 'def',
    tag: normalizeLabel(cap[1]),
    raw: rtrim(cap[0], '\n'),
    href: cap[2] ? cap[2].replace(RE.hrefBrackets, '$1').replace(RE.anyPunctuation, '$1') : '',
    title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(RE.anyPunctuation, '$1') : cap[3],
  };
}

function tableToken(ctx, src) {
  const cap = RE.table.exec(src);
  if (!cap) return undefined;
  if (!RE.tableDelimiter.test(cap[2])) return undefined; // a setext heading, not a table

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RE.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(RE.tableRowBlankLine, '').split('\n') : [];

  if (headers.length !== aligns.length) return undefined;

  const table = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const align of aligns) {
    if (RE.tableAlignRight.test(align)) table.align.push('right');
    else if (RE.tableAlignCenter.test(align)) table.align.push('center');
    else if (RE.tableAlignLeft.test(align)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    table.header.push({ text: headers[i], job: queueInline(ctx, headers[i]), header: true, align: table.align[i] });
  }
  for (const row of rows) {
    table.rows.push(splitCells(row, table.header.length).map((cell, i) => ({
      text: cell,
      job: queueInline(ctx, cell),
      header: false,
      align: table.align[i],
    })));
  }
  return table;
}

function lheadingToken(ctx, src) {
  const cap = RE.lheading.exec(src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    job: queueInline(ctx, text),
  };
}

function paragraphToken(ctx, src) {
  const cap = RE.paragraph.exec(src);
  if (!cap) return undefined;
  const text = cap[1].endsWith('\n') ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, job: queueInline(ctx, text), prefix: null };
}

function textToken(ctx, src) {
  const cap = RE.blockText.exec(src);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0], job: queueInline(ctx, cap[0]), prefix: null };
}

// The first character that is not a space, looking at most 3 spaces deep:
// most block rules allow up to 3 leading spaces, so this is the character
// that decides which of them can match at all. undefined when the line
// starts with 4+ spaces (then only indented code, a table header, a
// paragraph or plain text remain possible).
function firstContentChar(s) {
  let i = 0;
  while (i < 3 && s.charCodeAt(i) === 32) i++;
  const c = s.charCodeAt(i);
  return i === 3 && c === 32 ? undefined : s[i];
}

// Is this single line blank (only whitespace)? The fast scan covers the
// ASCII whitespace a generated line ever holds; anything beyond it defers
// to the exact /\s/ test.
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 12 || c === 11 || c === 13) continue;
    if (c < 128) return false;
    return /^\s*$/.test(s);
  }
  return true;
}

// Index of the first character that is not a space, or -1: the scan
// marked's /[^ ]/ search performs, without the regex call.
function firstNonSpaceIndex(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 32) return i;
  }
  return -1;
}

// Could this be an indented code block? Its first line begins with 4 spaces
// or with up to 3 spaces and a tab.
function couldBeIndentedCode(s) {
  let spaces = 0;
  while (s.charCodeAt(spaces) === 32) spaces++;
  if (spaces >= 4) return true;
  return s.charCodeAt(spaces) === 9;
}

// Does this text hold two consecutive blank lines at its end, the loose-list
// signal marked reads off an item's raw? Equivalent to /\n[ \t]*\n[ \t]*$/.
function endsWithDoubleBlank(raw) {
  let i = raw.length - 1;
  while (i >= 0 && (raw.charCodeAt(i) === 32 || raw.charCodeAt(i) === 9)) i--;
  if (i < 0 || raw.charCodeAt(i) !== 10) return false;
  i--;
  while (i >= 0 && (raw.charCodeAt(i) === 32 || raw.charCodeAt(i) === 9)) i--;
  return i >= 0 && raw.charCodeAt(i) === 10;
}

// Could the block starting here be a setext heading? Its underline line
// (up to 3 spaces, a run of = or -, then spaces or tabs) must appear before
// the first blank line, because setext text cannot cross one. Scanned by
// hand: the full lheading pattern is the most expensive failure in the
// block pass, and most blocks are not setext headings.
function couldBeSetext(s) {
  let pos = s.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < s.length) {
    let end = s.indexOf('\n', pos);
    if (end === -1) end = s.length;
    // blank line: the text would have ended before it
    let blank = true;
    for (let i = pos; i < end; i++) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank) return false;
    // underline?
    let i = pos;
    let spaces = 0;
    while (i < end && s.charCodeAt(i) === 32) { i++; spaces++; }
    if (spaces <= 3 && i < end) {
      const marker = s.charCodeAt(i);
      if (marker === 61 || marker === 45) {
        let j = i;
        while (j < end && s.charCodeAt(j) === marker) j++;
        let ok = j > i;
        while (ok && j < end) {
          const c = s.charCodeAt(j);
          if (c !== 32 && c !== 9) ok = false;
          j++;
        }
        if (ok) return true;
      }
    }
    if (end === s.length) return false;
    pos = end + 1;
  }
  return false;
}

// Could the block starting here be a table? Its second line must be a
// delimiter row, which uses only spaces, pipes, colons and dashes and
// holds at least one dash.
function couldBeTable(s) {
  const nl = s.indexOf('\n');
  if (nl === -1) return false;
  let dash = false;
  for (let i = nl + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) return dash;
    if (c === 45) dash = true;
    else if (c !== 32 && c !== 124 && c !== 58) return false;
  }
  return dash;
}

// ---------------------------------------------------------------------------
// The block pass. Mirrors marked's ordering and its merge rules for blocks
// that turn out to continue the previous paragraph.
// ---------------------------------------------------------------------------

function blockTokens(ctx, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) srcLength = src.length;
    else { infiniteLoop(src.charCodeAt(0)); break; }

    let token;

    if (token = (() => { const cap = RE.newline.exec(src); return cap && cap[0].length > 0 ? { type: 'space', raw: cap[0] } : undefined; })()) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (token.raw.length === 1 && last !== undefined) {
        last.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    const lead = firstContentChar(src);

    if (couldBeIndentedCode(src) && (token = codeToken(ctx, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if ((lead === '`' || lead === '~') && (token = fencesToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if (lead === '#' && (token = headingToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((lead === '-' || lead === '_' || lead === '*') && (token = hrToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if (lead === '>' && (token = blockquoteToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((lead === '*' || lead === '+' || lead === '-' || (lead >= '0' && lead <= '9')) && (token = listToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if (lead === '<' && (token = htmlToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }

    if (lead === '[' && (token = defToken(ctx, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.raw;
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        if (!ctx.tokens.links[token.tag]) {
          ctx.tokens.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    if (couldBeTable(src) && (token = tableToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if (couldBeSetext(src) && (token = lheadingToken(ctx, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }

    if (ctx.top && (token = paragraphToken(ctx, src))) {
      const last = tokens[tokens.length - 1];
      if (lastParagraphClipped && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }

    if (token = textToken(ctx, src)) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = last.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) { infiniteLoop(src.charCodeAt(0)); break; }
  }

  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline engine. Renders one inline run straight to its final string: HTML
// normally, or plain text when `textMode` is set (image alt text). The scan
// order and state effects follow marked's inline tokenizer exactly.
// ---------------------------------------------------------------------------

// Does a link label end inside an inline tag or autolink? Then what looked
// like a link is not one.
function labelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = RE.inlineCode.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(labelStart + i);
    const token = RE.tag.exec(rest) || RE.autolink.exec(rest);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Would this text itself produce a link? Images do not count.
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(RE.blockSkip)) {
    if (RE.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(RE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask the parts of an inline run that emphasis must not see into: reference
// links that resolve, escaped punctuation, and link/code/html spans. Every
// mask keeps the length it replaces, so positions line up with the source.
function maskSrc(ctx, src) {
  let masked = src;
  if (src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(RE.reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(RE.reflinkSearch, maskReflink);
  }
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(RE.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(RE.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// Render a link or image once its destination is known. Returns undefined
// when a non-image link turns out to contain another link: the outer one is
// abandoned and its text gets re-scanned by the caller.
function outputLink(ctx, cap, link, raw, textMode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(ctx, text, isImage ? true : textMode);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return undefined;
    }
    ctx.linkEmitted = true;
  }

  if (textMode) return { raw, html: inner };

  if (isImage) {
    const clean = cleanUrl(href);
    if (clean === null) return { raw, html: escapeHtml(inner) };
    let out = `<img src="${escapeHtml(clean)}" alt="${escapeHtml(inner)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return { raw, html: out + '>' };
  }

  const clean = cleanUrl(href);
  if (clean === null) return { raw, html: inner };
  let out = '<a href="' + escapeHtml(clean) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  return { raw, html: out + '>' + inner + '</a>' };
}

// Try emphasis or strong at the head of `src`. On success returns the raw
// span and its rendered body; the caller wraps it.
function emStrongAt(ctx, src, maskedSrc, prevChar, hints, textMode) {
  let match = RE.emStrongLDelim.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;

  // Flanking is judged on the whole delimiter run, which may start before
  // this slice of the source.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const beforeRun = maskedSrc.slice(Math.max(0, runStart - 2), runStart);
  const lastUnit = beforeRun.charCodeAt(beforeRun.length - 1);
  const runPrevChar = beforeRun.length === 0 ? ''
    : lastUnit >= 0xdc00 && lastUnit <= 0xdfff && beforeRun.length > 1
      ? beforeRun.slice(-2)
      : beforeRun.slice(-1);
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!RE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!RE.punctuation.exec(prevChar);

  if (match[4] && prevChar.match(RE.unicodeAlphaNumeric)) return undefined;

  const nextChar = match[1] || match[3] || '';
  if (nextChar && prevChar && !prevPunct) return undefined;

  const lLength = codePointLength(match[0]) - 1;
  let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
  const runLength = srcStart - runStart + lLength;
  const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
  const endReg = delimChar === '*' ? RE.emStrongRDelimAst : RE.emStrongRDelimUnd;
  const lastCloser = hints[delimChar];
  const windowStart = maskedSrc.length - src.length + lLength;
  if (lastCloser < windowStart) return undefined;
  maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
  const lastCloserInWindow = lastCloser - windowStart;
  endReg.lastIndex = 0;

  while ((match = endReg.exec(maskedSrc)) !== null) {
    if (match.index > lastCloserInWindow) break;
    rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!rDelim) continue;
    rLength = rDelim.length; // a delimiter run is pure ASCII

    if (match[3] || match[4]) { // another left delimiter
      delimTotal += rLength;
      continue;
    } else if (match[5] || match[6] || openerCanClose) { // left or right
      if (midRun && (match[5] || match[6])) break;
      if (runLength % 3 && !((runLength + rLength) % 3)) {
        midDelimTotal += rLength;
        continue; // CommonMark rules 9 and 10
      }
    }

    delimTotal -= rLength;
    if (delimTotal > 0) continue;

    rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
    const lastCharLength = firstCodePointLength(match[0]);
    const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

    if (Math.min(lLength, rLength) % 2) {
      const text = raw.slice(1, -1);
      return { raw, kind: 'em', inner: renderInline(ctx, text, textMode) };
    }
    const text = raw.slice(2, -2);
    return { raw, kind: 'strong', inner: renderInline(ctx, text, textMode) };
  }
  return undefined;
}

// Try strikethrough at the head of `src`.
function delAt(ctx, src, maskedSrc, prevChar, hints, textMode) {
  let match = RE.delLDelim.exec(src);
  if (!match) return undefined;
  const nextChar = match[1] || '';
  if (nextChar && prevChar && !RE.punctuation.exec(prevChar)) return undefined;

  const lLength = codePointLength(match[0]) - 1;
  let rDelim, rLength, delimTotal = lLength;
  const endReg = RE.delRDelim;
  const lastCloser = hints['~'];
  const windowStart = maskedSrc.length - src.length + lLength;
  if (lastCloser < windowStart) return undefined;
  maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
  const lastCloserInWindow = lastCloser - windowStart;
  endReg.lastIndex = 0;

  while ((match = endReg.exec(maskedSrc)) !== null) {
    if (match.index > lastCloserInWindow) break;
    rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!rDelim) continue;
    rLength = rDelim.length; // a tilde run is pure ASCII
    if (rLength !== lLength) continue;
    if (match[3] || match[4]) {
      delimTotal += rLength;
      continue;
    }
    delimTotal -= rLength;
    if (delimTotal > 0) continue;

    rLength = Math.min(rLength, rLength + delimTotal);
    const lastCharLength = firstCodePointLength(match[0]);
    const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
    const text = raw.slice(lLength, -lLength);
    return { raw, inner: renderInline(ctx, text, textMode) };
  }
  return undefined;
}

// Try an inline link or image at the head of `src`.
function linkAt(ctx, src, textMode) {
  if (ctx.linkParenPossible === false) return undefined;
  const cap = RE.link.exec(src);
  if (!cap) return undefined;

  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInsideToken(src, cap[1], labelStart)) return undefined;

  const trimmedUrl = cap[2].trim();
  if (/^</.test(trimmedUrl)) {
    if (!/>$/.test(trimmedUrl)) return undefined;
    const unescaped = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - unescaped.length) % 2 === 0) return undefined;
  } else {
    const lastParen = findClosingBracket(cap[2], '()');
    if (lastParen === -2) return undefined;
    if (lastParen > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescapedEnd = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescapedEnd.length) % 2 === 0) return undefined;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (/^</.test(href)) href = href.slice(1, -1);
  return outputLink(ctx, cap, {
    href: href ? href.replace(RE.anyPunctuation, '$1') : href,
    title: title ? title.replace(RE.anyPunctuation, '$1') : title,
  }, cap[0], textMode);
}

// Try a reference link or a shortcut reference at the head of `src`.
// Returns { raw, html } for a resolved link, { raw, single } when only the
// first character is text, or undefined.
function reflinkAt(ctx, src, textMode) {
  let cap = RE.reflink.exec(src) || RE.nolink.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInsideToken(src, cap[1], labelStart)) return undefined;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { raw: ch, single: ch };
  }
  return outputLink(ctx, cap, link, cap[0], textMode);
}

// Render one autolink-style token (a <scheme:...> / <email> autolink or a
// GFM extended autolink): in text mode it is just its text.
function autolinkHtml(text, href, textMode) {
  if (textMode) return text;
  const clean = cleanUrl(href);
  if (clean === null) return escapeHtml(text, true);
  let out = '<a href="' + escapeHtml(clean, true) + '"';
  out += '>' + escapeHtml(text, true) + '</a>';
  return out;
}

// The inline scan itself.
const NO_CLOSERS = { '*': -1, _: -1, '~': -1 };

function renderInline(ctx, src, textMode) {
  const prevParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevParenPossible && src.includes(')');
  const out = renderInlineRun(ctx, src, textMode);
  ctx.linkParenPossible = prevParenPossible;
  return out;
}

const INLINE_SPECIAL = /[*_~`\[\\<!]/;
const AUTOLINK_TRIGGER = /@|www\.|:\/\//;

function renderInlineRun(ctx, src, textMode) {
  // A run with nothing special in it is a single text chunk: no emphasis
  // characters, no brackets, backslashes, backticks or tags, no hard break
  // and nothing an extended autolink could start from.
  if (!INLINE_SPECIAL.test(src) && !src.includes('  \n') && !AUTOLINK_TRIGGER.test(src)) {
    const decoded = ctx.inRawBlock || !src.includes('&') ? src : decodeNumericRefs(src);
    return textMode || ctx.inRawBlock ? decoded : escapeHtml(decoded);
  }

  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = needsMask ? maskSrc(ctx, src) : src;
  const hints = needsMask ? scanCloserHints(maskedSrc) : NO_CLOSERS;

  let out = '';
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;

  while (src) {
    if (src.length < srcLength) srcLength = src.length;
    else { infiniteLoop(src.charCodeAt(0)); break; }

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    // Dispatch on the first character: at any position only a few of the
    // inline rules can possibly match, and the rest would each pay a regex
    // call to fail on that character. The order inside each branch is the
    // tokenizer's own order.
    const c = src.charCodeAt(0);
    let cap;

    if (c === 92) { // backslash: escape, or a hard break when a newline follows
      if (cap = RE.escape.exec(src)) {
        out += textMode ? cap[1] : escapeHtml(cap[1]);
        src = src.substring(cap[0].length);
        continue;
      }
      if (cap = RE.br.exec(src)) {
        out += textMode ? '' : '<br>';
        src = src.substring(cap[0].length);
        continue;
      }
    } else if (c === 60) { // '<': inline tag, then <autolink>
      if (cap = RE.tag.exec(src)) {
        if (!ctx.inLink && RE.startATag.test(cap[0])) ctx.inLink = true;
        else if (ctx.inLink && RE.endATag.test(cap[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && RE.startPreScriptTag.test(cap[0])) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && RE.endPreScriptTag.test(cap[0])) ctx.inRawBlock = false;
        out += cap[0];
        src = src.substring(cap[0].length);
        continue;
      }
      if (cap = RE.autolink.exec(src)) {
        const text = cap[1];
        const href = cap[2] === '@' ? 'mailto:' + text : text;
        out += autolinkHtml(text, href, textMode);
        src = src.substring(cap[0].length);
        continue;
      }
    } else if (c === 91 || (c === 33 && src.charCodeAt(1) === 91)) { // '[' or '!['
      const linked = linkAt(ctx, src, textMode);
      if (linked !== undefined) {
        out += linked.html;
        src = src.substring(linked.raw.length);
        continue;
      }
      const ref = reflinkAt(ctx, src, textMode);
      if (ref !== undefined) {
        out += ref.single !== undefined ? (textMode ? ref.single : escapeHtml(ref.single)) : ref.html;
        src = src.substring(ref.raw.length);
        continue;
      }
    } else if (c === 42 || c === 95) { // '*' or '_': emphasis and strong
      const em = emStrongAt(ctx, src, maskedSrc, prevChar, hints, textMode);
      if (em !== undefined) {
        out += textMode ? em.inner : (em.kind === 'em' ? '<em>' + em.inner + '</em>' : '<strong>' + em.inner + '</strong>');
        src = src.substring(em.raw.length);
        continue;
      }
    } else if (c === 96) { // '`': code span
      if (cap = RE.inlineCode.exec(src)) {
        let text = cap[2].replace(/\n/g, ' ');
        const hasNonSpace = RE.nonSpace.test(text);
        const bothEndsSpace = /^ /.test(text) && / $/.test(text);
        if (hasNonSpace && bothEndsSpace) text = text.substring(1, text.length - 1);
        out += textMode ? text : '<code>' + escapeHtml(text, true) + '</code>';
        src = src.substring(cap[0].length);
        continue;
      }
    } else if (c === 126) { // '~': strikethrough
      const del = delAt(ctx, src, maskedSrc, prevChar, hints, textMode);
      if (del !== undefined) {
        out += textMode ? del.inner : '<del>' + del.inner + '</del>';
        src = src.substring(del.raw.length);
        continue;
      }
    } else if (c === 32) { // ' ': a hard break needs two spaces and a newline
      if (cap = RE.br.exec(src)) {
        out += textMode ? '' : '<br>';
        src = src.substring(cap[0].length);
        continue;
      }
    }

    // Extended autolinks start with a letter, a digit or one of . _ + -
    if (!ctx.inLink
      && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
        || c === 46 || c === 95 || c === 43 || c === 45)
      && (cap = RE.url.exec(src))) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
        out += autolinkHtml(text, href, textMode);
        src = src.substring(cap[0].length);
        continue;
      }
      let prev;
      do {
        prev = cap[0];
        cap[0] = RE.backpedal.exec(cap[0])?.[0] ?? '';
      } while (prev !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
      if (text) {
        out += autolinkHtml(text, href, textMode);
        src = src.substring(text.length);
        continue;
      }
    }

    // plain text up to the next special character
    if (cap = RE.inlineText.exec(src)) {
      const rawText = cap[0];
      if (rawText.slice(-1) !== '_') prevChar = rawText.slice(-1);
      keepPrevChar = true;
      // A numeric reference needs an '&'; without one the text is itself.
      const decoded = ctx.inRawBlock || !rawText.includes('&') ? rawText : decodeNumericRefs(rawText);
      if (textMode || ctx.inRawBlock) {
        out += decoded;
      } else {
        out += escapeHtml(decoded);
      }
      src = src.substring(rawText.length);
      continue;
    }

    if (src) { infiniteLoop(src.charCodeAt(0)); break; }
  }

  return out;
}


// ---------------------------------------------------------------------------
// Block rendering: tokens to HTML, following marked's renderer.
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function codeHtml(token) {
  const langString = (token.lang || '').match(RE.notSpaceStart)?.[0];
  const code = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeHtml(langString) + '">'
    + escapeHtml(code, true) + '</code></pre>\n';
}

function tableHtml(token) {
  let cell = '';
  for (const head of token.header) cell += tableCellHtml(head);
  let body = '';
  for (const row of token.rows) {
    let rowCell = '';
    for (const c of row) rowCell += tableCellHtml(c);
    body += `<tr>\n${rowCell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + `<tr>\n${cell}</tr>\n` + '</thead>\n' + body + '</table>\n';
}

function tableCellHtml(token) {
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + (token.job ? token.job.html : '') + `</${type}>\n`;
}

function listHtml(token) {
  let body = '';
  for (const item of token.items) {
    body += `<li>${renderBlocks(item.tokens)}</li>\n`;
  }
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
  return `<${type}${startAttr}>\n${body}</${type}>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${token.job.html}</h${token.depth}>\n`; break;
      case 'code': out += codeHtml(token); break;
      case 'table': out += tableHtml(token); break;
      case 'blockquote': out += `<blockquote>\n${renderBlocks(token.tokens)}</blockquote>\n`; break;
      case 'list': out += listHtml(token); break;
      case 'checkbox': out += checkboxHtml(token.checked); break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': {
        out += '<p>' + (token.prefix ? checkboxHtml(token.prefix.checked) : '') + (token.job ? token.job.html : '') + '</p>\n';
        break;
      }
      case 'text': {
        out += (token.prefix ? checkboxHtml(token.prefix.checked) : '') + (token.job ? token.job.html : '');
        break;
      }
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const ctx = newContext();
  const tokens = [];
  tokens.links = ctx.links;
  ctx.tokens = tokens;

  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  blockTokens(ctx, src, tokens);

  for (const job of ctx.queue) {
    ctx.inRawBlock = false;
    job.html = renderInline(ctx, job.src, false);
  }

  return renderBlocks(tokens);
}
