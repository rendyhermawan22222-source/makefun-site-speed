// Quillrun: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build(input) returns: the output tree, path -> text.
// The rules are makefun-site's own (its README and its code). This module reaches the same answers by a different
// route, built around where the reference spends its CPU:
//
//   * Escaping is done in runs. Plain characters are never touched one by one through a regex: a scanner looks for
//     the five characters the escape table names and copies everything between them as a single slice.
//   * Markdown is lexed by hand-written character tests instead of one regex per line per rule, with the exact
//     semantics of each of the reference's patterns (including the line terminators `.` refuses to match).
//   * Templates are compiled, not interpreted: each layout is turned into one JavaScript function per kind of page
//     (a page, an index page, a tag page, the tags page), with every include inlined, every loop a plain `for`, every
//     `loop.*` read straight from the loop counter, and every root name the page kind lacks folded to `undefined`.
//   * Partial evaluation by dependency analysis: while compiling, every included fragment learns which values it
//     reads. A fragment that reads only the build's constants (site, tags, recent) is rendered once per build; a
//     fragment that reads only one loop element (a post's card, its tag list) is rendered once per element. A post's
//     card is then rendered once, however many index and tag pages list it.
//   * Slugs of plain ASCII skip Unicode normalisation (NFKD is the identity there), and every slug is memoised for
//     the length of one build.
//
// Nothing is cached across cases: every memo lives inside one call of run().

// ------------------------------------------------------------------------------------------------ text

const SPECIAL = new Uint8Array(128);
SPECIAL[34] = 1; // "
SPECIAL[38] = 1; // &
SPECIAL[39] = 1; // '
SPECIAL[60] = 1; // <
SPECIAL[62] = 1; // >

function escTail(s, i) {
  let out = s.slice(0, i);
  let from = i;
  const n = s.length;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c > 62 || SPECIAL[c] === 0) continue;
    if (i > from) out += s.slice(from, i);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    from = i + 1;
  }
  return from < n ? out + s.slice(from) : out;
}

/** `s` with & < > " and ' escaped: the input itself when it holds none of them. */
export function esc(s) {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c <= 62 && SPECIAL[c] === 1) return escTail(s, i);
  }
  return s;
}

/** JavaScript's \s, by code unit. */
function isSpace(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** How many runs of non-whitespace `text` holds (the reference's text.match(/\S+/g).length). */
function wordCount(text) {
  let n = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    const sp = c < 128 ? c === 32 || (c >= 9 && c <= 13) : isSpace(c);
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const MARKS = /\p{M}/gu;

/** The slug of `text` (makefun-site's rule), uncached. */
function slugRaw(text) {
  let plain = text;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(MARKS, '');
      break;
    }
  }
  // Only A-Z, a-z and 0-9 are ever kept, all of them single code units, so walking code units is walking code points.
  let out = '';
  let gap = false;
  const n = plain.length;
  for (let i = 0; i < n; i++) {
    let c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(c);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------------------------------------ front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    const last = raw.length - 1;
    let from = 1;
    for (let i = 1; i < last; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === last) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(from, i);
        from = i + 1;
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    return { value: out + raw.slice(from, last) };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        if (t === '' || !TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

function blankST(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** { data, body } or { error }: the reference's parseFrontMatter, walking the text by offsets. */
function frontMatterOf(text) {
  // lines[0] must be exactly '---'.
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (firstEnd !== 3 || !text.startsWith('---')) return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // Find the closing line '---'.
  let lineNo = 1; // index of the line being looked at
  let pos = firstNl + 1;
  let closeStart = -1;
  let closeNl = -1;
  const starts = [];
  const ends = [];
  const len = text.length;
  while (pos <= len) {
    let nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeNl = nl;
      break;
    }
    starts.push(pos);
    ends.push(end);
    lineNo++;
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k];
    const e = ends[k];
    if (blankST(text, a, e) || text.charCodeAt(a) === 35) continue;
    const line = text.slice(a, e);
    const m = LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    let re = raw.length;
    while (re > 0) {
      const c = raw.charCodeAt(re - 1);
      if (c !== 32 && c !== 9) break;
      re--;
    }
    if (re !== raw.length) raw = raw.slice(0, re);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// ------------------------------------------------------------------------------------------------ markdown

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether a code unit is one `.` refuses in a regex (a line terminator). */
const isTerm = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

function hasTerm(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2028 || c === 0x2029 || c === 13 || c === 10) return true;
  }
  return false;
}

function isBlank(l) {
  const n = l.length;
  for (let i = 0; i < n; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** FENCE_OPEN: the language, or null. */
function fenceOpen(l) {
  if (l.charCodeAt(0) !== 96 || l.charCodeAt(1) !== 96 || l.charCodeAt(2) !== 96) return null;
  const n = l.length;
  let i = 3;
  while (i < n) {
    const c = l.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  for (; i < n; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return l.slice(3, langEnd);
}

function fenceClose(l) {
  if (l.charCodeAt(0) !== 96 || l.charCodeAt(1) !== 96 || l.charCodeAt(2) !== 96) return false;
  const n = l.length;
  for (let i = 3; i < n; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** HEADING with a non-empty text: { depth, text } or null. */
function headingOf(l) {
  if (l.charCodeAt(0) !== 35) return null;
  const n = l.length;
  let h = 1;
  while (h < n && l.charCodeAt(h) === 35) h++;
  if (h > 6 || h >= n) return null;
  let c = l.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h + 1;
  while (a < n && ((c = l.charCodeAt(a)) === 32 || c === 9)) a++;
  let e = n;
  while (e > a && ((c = l.charCodeAt(e - 1)) === 32 || c === 9)) e--;
  if (e === a) return null;
  if (hasTerm(l, a, e)) return null;
  return { depth: h, text: l.slice(a, e) };
}

function isHr(l) {
  const c0 = l.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (l.charCodeAt(1) !== c0 || l.charCodeAt(2) !== c0) return false;
  const n = l.length;
  for (let i = 3; i < n; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(l) {
  if (l.length === 0) return true;
  const c0 = l.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(l);
  if (c0 === 96) return fenceOpen(l) !== null;
  if (c0 === 35) return headingOf(l) !== null;
  if (c0 === 45 || c0 === 42) return isHr(l);
  return false;
}

/** Spaces and tabs at both ends dropped. */
function trimST(l) {
  const n = l.length;
  let a = 0;
  let c;
  while (a < n && ((c = l.charCodeAt(a)) === 32 || c === 9)) a++;
  let e = n;
  while (e > a && ((c = l.charCodeAt(e - 1)) === 32 || c === 9)) e--;
  return a === 0 && e === n ? l : l.slice(a, e);
}

/** BULLET's item text, or null. */
function bulletOf(l) {
  const c0 = l.charCodeAt(0);
  if ((c0 !== 45 && c0 !== 42) || l.charCodeAt(1) !== 32) return null;
  if (hasTerm(l, 2, l.length)) return null;
  return l.slice(2);
}

/** ORDERED: the digits' length (the text after ". " follows them), or 0. */
function orderedLen(l) {
  const n = l.length;
  let d = 0;
  while (d < n && d < 10) {
    const c = l.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9) return 0;
  if (l.charCodeAt(d) !== 46 || l.charCodeAt(d + 1) !== 32) return 0;
  if (hasTerm(l, d + 2, n)) return 0;
  return d;
}

function continued(l) {
  if (l.charCodeAt(0) !== 32 || l.charCodeAt(1) !== 32) return false;
  const n = l.length;
  let i = 2;
  while (i < n && l.charCodeAt(i) === 32) i++;
  return i < n && !isSpace(l.charCodeAt(i));
}

function findUnescaped2(s, from) {
  // the first "**" from `from`, outside an escape
  const n = s.length;
  for (let j = from; j <= n - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n) {
        const d = s.charCodeAt(j + 1);
        if (d < 128 && ESCAPABLE[d] === 1) {
          j++;
          continue;
        }
      }
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

function findBracket(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n) {
        const d = s.charCodeAt(j + 1);
        if (d < 128 && ESCAPABLE[d] === 1) {
          j++;
          continue;
        }
      }
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n) {
        const d = s.charCodeAt(j + 1);
        if (d < 128 && ESCAPABLE[d] === 1) j++;
      }
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS = /\s/;

/**
 * `s` rendered inline. Plain text is copied a run at a time; only the characters that open a construct or that the
 * escape table names stop the run.
 */
function inline(s, link) {
  let out = '';
  let i = 0;
  let from = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c > 96) {
      i++;
      continue;
    }
    switch (c) {
      case 92: {
        if (i + 1 < n) {
          const d = s.charCodeAt(i + 1);
          if (d < 128 && ESCAPABLE[d] === 1) {
            if (i > from) out += s.slice(from, i);
            out += d === 62 ? '&gt;' : s[i + 1];
            i += 2;
            from = i;
            continue;
          }
        }
        i++;
        continue;
      }
      case 96: {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) {
          if (i > from) out += s.slice(from, i);
          out += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
          i = j + 1;
          from = i;
        } else i++;
        continue;
      }
      case 42: {
        if (s.charCodeAt(i + 1) === 42) {
          const j = findUnescaped2(s, i + 2);
          if (j > i + 2) {
            if (i > from) out += s.slice(from, i);
            out += '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
            i = j + 2;
            from = i;
          } else i += 2;
          continue;
        }
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > from) out += s.slice(from, i);
          out += '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
          i = j + 1;
          from = i;
        } else i++;
        continue;
      }
      case 91: {
        const k = findBracket(s, i + 1);
        const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
        if (m > k + 2) {
          const target = s.slice(k + 2, m);
          if (!WS.test(target)) {
            if (i > from) out += s.slice(from, i);
            out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
            i = m + 1;
            from = i;
            continue;
          }
        }
        i++;
        continue;
      }
      case 38:
      case 60:
      case 62:
      case 34:
      case 39:
        if (i > from) out += s.slice(from, i);
        out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
        i++;
        from = i;
        continue;
      default:
        i++;
    }
  }
  if (from === 0) return s;
  return from < n ? out + s.slice(from) : out;
}

/** `src` rendered: { html, toc, excerpt }. `slug` is the build's memoised slug rule. */
function renderMarkdown(src, link, slug) {
  const lines = src.split('\n');
  const nl = lines.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < nl) {
    const line = lines[i];
    const L = line.length;
    if (L === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if ((c0 === 32 || c0 === 9) && isBlank(line)) {
      i++;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        let body = '';
        while (i < nl && !fenceClose(lines[i])) body += esc(lines[i++]) + '\n';
        i++;
        html += (lang === '' ? '<pre><code>' : '<pre><code class="language-' + lang + '">') + body + '</code></pre>\n';
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slug(h.text), ids);
        const inner = inline(h.text, link);
        html += '<h' + h.depth + ' id="' + id + '">' + inner + '</h' + h.depth + '>\n';
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: inner });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (c0 === 62) {
      let text = '';
      let any = false;
      while (i < nl) {
        const q = lines[i];
        if (q.charCodeAt(0) !== 62) break;
        const t = trimST(q.charCodeAt(1) === 32 ? q.slice(2) : q.slice(1));
        if (t !== '') {
          text = any ? text + '\n' + t : t;
          any = true;
        }
        i++;
      }
      html += any ? '<blockquote>\n<p>' + inline(text, link) + '</p>\n</blockquote>\n' : '<blockquote>\n</blockquote>\n';
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const b = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
      const od = b === null && c0 >= 48 && c0 <= 57 ? orderedLen(line) : 0;
      if (b !== null || od !== 0) {
        const ordered = od !== 0;
        const items = [];
        let cur = null;
        while (i < nl) {
          const l = lines[i];
          let t = null;
          if (ordered) {
            const d = orderedLen(l);
            if (d !== 0) t = l.slice(d + 2);
          } else t = bulletOf(l);
          if (t !== null) {
            if (cur !== null) items.push(cur);
            cur = trimST(t);
            i++;
          } else if (continued(l)) {
            cur += '\n' + trimST(l);
            i++;
          } else break;
        }
        items.push(cur);
        let block;
        if (ordered) {
          const start = Number(line.slice(0, od));
          block = start !== 1 ? '<ol start="' + start + '">\n' : '<ol>\n';
        } else block = '<ul>\n';
        for (let k = 0; k < items.length; k++) block += '<li>' + inline(items[k], link) + '</li>\n';
        html += block + (ordered ? '</ol>\n' : '</ul>\n');
        continue;
      }
    }
    let text = trimST(line);
    i++;
    while (i < nl && !endsParagraph(lines[i])) text += '\n' + trimST(lines[i++]);
    const inner = inline(text, link);
    if (excerpt === null) excerpt = inner;
    html += '<p>' + inner + '</p>\n';
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------------------------------------ templates: parsing

class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const ST_ONLY = /^[ \t]*$/;

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = ST_ONLY.test(src.slice(lineStart, open)) && ST_ONLY.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ------------------------------------------------------------------------------------------------ templates: values

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** One step of a path: an own property of an object, else undefined. */
function prop(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

// ------------------------------------------------------------------------------------------------ templates: compiler
//
// A layout is compiled for one kind of render, which fixes the root names it can see (site, tags and recent always;
// page, or posts and pager, or tag). The generated function takes the root values and a per-build memo array and
// returns the page's text. Includes are inlined at compile time, depth by depth, so the 8-deep cut-off is decided
// while compiling. Each inlined include records the values it reads; when they are only build constants, or one loop
// element, its text is memoised.

const CONST_ROOTS = new Set(['site', 'tags', 'recent']);
const MAX_CODE = 1 << 21;

class Overflow extends Error {}

/**
 * One build's template compiler. Layouts are compiled per kind of render; memoisable fragments are compiled once into
 * shared functions keyed by their generated code, so the same fragment reached from two layouts (a card listed on the
 * index and on a tag page) shares one memo.
 */
function makeCompiler(templates) {
  const fragments = []; // fragment functions, by index
  const fragmentByCode = new Map();
  let total = 0;

  function makeGen(rootNames) {
    let nextId = 0;

    function resolve(path, frames, deps) {
      const p0 = path[0];
      if (frames.length > 0) {
        if (p0 === 'loop') {
          const fr = frames[frames.length - 1];
          deps.add('M' + fr.id);
          const id = fr.id;
          if (path.length === 1) return `{index:i${id}+1,first:i${id}===0,last:i${id}===n${id}-1,length:n${id}}`;
          if (path.length > 2) return 'undefined';
          const k = path[1];
          if (k === 'index') return `(i${id}+1)`;
          if (k === 'first') return `(i${id}===0)`;
          if (k === 'last') return `(i${id}===n${id}-1)`;
          if (k === 'length') return `n${id}`;
          return 'undefined';
        }
        for (let f = frames.length - 1; f >= 0; f--) {
          const fr = frames[f];
          if (fr.name === p0) {
            deps.add('X' + fr.id);
            let e = `x${fr.id}`;
            for (let k = 1; k < path.length; k++) e = `prop(${e},${JSON.stringify(path[k])})`;
            return e;
          }
        }
      }
      if (!rootNames.has(p0)) return 'undefined';
      deps.add('R' + p0);
      let e = `r_${p0}`;
      for (let k = 1; k < path.length; k++) e = `prop(${e},${JSON.stringify(path[k])})`;
      return e;
    }

    function gen(nodes, frames, depth, deps) {
      let code = '';
      for (const n of nodes) {
        switch (n.kind) {
          case 'text':
            code += `o.push(${JSON.stringify(n.text)});`;
            break;
          case 'var':
            code += `o.push(esc(textOf(${resolve(n.path, frames, deps)})));`;
            break;
          case 'raw':
            code += `o.push(textOf(${resolve(n.path, frames, deps)}));`;
            break;
          case 'if': {
            const v = resolve(n.path, frames, deps);
            const t = gen(n.then, frames, depth, deps);
            const e = n.else === null ? '' : gen(n.else, frames, depth, deps);
            code += `if(${n.not ? '!' : ''}truthy(${v})){${t}}${e === '' ? '' : `else{${e}}`}`;
            break;
          }
          case 'for': {
            const xs = resolve(n.path, frames, deps);
            const id = nextId++;
            const inner = gen(n.body, [...frames, { name: n.name === 'loop' ? '\u0000loop' : n.name, id }], depth, deps);
            deps.delete('X' + id);
            deps.delete('M' + id);
            code += `{const a${id}=${xs};if(Array.isArray(a${id})){const n${id}=a${id}.length;for(let i${id}=0;i${id}<n${id};i${id}++){const x${id}=a${id}[i${id}];${inner}}}}`;
            break;
          }
          case 'include': {
            const t = templates.get(n.name);
            if (t === undefined || depth >= 8) break;
            const own = new Set();
            const body = gen(t, frames, depth + 1, own);
            for (const d of own) deps.add(d);
            let elems = 0;
            let elemId = '';
            let ok = true;
            for (const d of own) {
              if (d[0] === 'M') ok = false;
              else if (d[0] === 'R') {
                if (!CONST_ROOTS.has(d.slice(1))) ok = false;
              } else {
                elems++;
                elemId = d.slice(1);
              }
            }
            if (!ok || elems > 1 || body.length < 48) {
              code += `{${body}}`;
              break;
            }
            // Regenerate the fragment on its own: the one loop element it reads becomes its parameter.
            let frame = null;
            for (const fr of frames) if (String(fr.id) === elemId) frame = fr;
            const k = fragment(t, frame === null ? null : frame.name, depth + 1, rootNames);
            code += `o.push(frag[${k}](r_site,r_tags,r_recent${frame === null ? '' : `,x${elemId}`}));`;
            break;
          }
        }
        if (code.length > MAX_CODE) throw new Overflow();
      }
      return code;
    }
    return gen;
  }

  const FACTORY_ARGS = ['prop', 'textOf', 'truthy', 'esc', 'frag'];

  function fragment(nodes, elemName, depth, rootNames) {
    const gen = makeGen(rootNames);
    const frames = elemName === null ? [] : [{ name: elemName, id: 'E' }];
    const body = gen(nodes, frames, depth, new Set());
    const key = (elemName === null ? 'C\u0000' : 'E\u0000') + body;
    let k = fragmentByCode.get(key);
    if (k !== undefined) return k;
    total += body.length;
    if (total > MAX_CODE * 4) throw new Overflow();
    const fn = new Function(...FACTORY_ARGS, `return function(r_site,r_tags,r_recent,xE){const o=[];${body}return o.join('');};`)(prop, textOf, truthy, esc, fragments);
    let wrapped;
    if (elemName === null) {
      let cached;
      wrapped = (a, b, c) => (cached !== undefined ? cached : (cached = fn(a, b, c)));
    } else {
      const cache = new Map();
      wrapped = (a, b, c, x) => {
        let v = cache.get(x);
        if (v === undefined) {
          v = fn(a, b, c, x);
          cache.set(x, v);
        }
        return v;
      };
    }
    k = fragments.length;
    fragments.push(wrapped);
    fragmentByCode.set(key, k);
    return k;
  }

  /** A layout compiled for one kind of render: (vars) => text. */
  function layout(name, rootNames) {
    const gen = makeGen(rootNames);
    const body = gen(templates.get(name), [], 0, new Set());
    total += body.length;
    if (total > MAX_CODE * 4) throw new Overflow();
    const order = [...rootNames];
    const fn = new Function(...FACTORY_ARGS, `return function(${order.map((r) => `r_${r}`).join(',')}){const o=[];${body}return o.join('');};`)(prop, textOf, truthy, esc, fragments);
    if (order.length === 3) return (v) => fn(v[order[0]], v[order[1]], v[order[2]]);
    if (order.length === 4) return (v) => fn(v[order[0]], v[order[1]], v[order[2]], v[order[3]]);
    return (v) => fn(...order.map((r) => v[r]));
  }

  return { layout };
}

// The interpreter, for a template set whose inlining would grow too large (deep or recursive includes).
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function interpret(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += interpret(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += interpret(n.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < 8) out += interpret(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

export function run(input) {
  // One build's memo of slugs: nothing outlives this call.
  const slugMemo = new Map();
  const slug = (text) => {
    let s = slugMemo.get(text);
    if (s === undefined) {
      s = slugRaw(text);
      slugMemo.set(text, s);
    }
    return s;
  };

  // Templates, in code-unit order of their names.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    const p = f.path;
    if (p.endsWith('.md')) {
      let t = f.content;
      if (t.indexOf('\r') !== -1) t = t.replace(/\r\n?/g, '\n');
      sources.push({ path: p, text: t });
    } else statics.push(f);
  }

  // 2. Front matter.
  const kept = [];
  for (const s of sources) {
    const fm = frontMatterOf(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35 || SCHEME.test(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return hit.url + frag;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const list = s.data.tags;
    if (list === undefined) return [];
    const seen = new Set();
    const out = [];
    for (const name of list) {
      const sl = slug(name);
      if (seen.has(sl)) continue;
      seen.add(sl);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cardOf = (s) => {
    const date = s.data.date;
    return {
      title: s.data.title,
      url: s.url,
      date: date ?? '',
      date_long: date === undefined ? '' : longDate(date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  // Compile each layout for each kind of render it is used for.
  const ROOTS = {
    page: new Set(['site', 'tags', 'recent', 'page']),
    index: new Set(['site', 'tags', 'recent', 'posts', 'pager']),
    tag: new Set(['site', 'tags', 'recent', 'tag']),
    tags: new Set(['site', 'tags', 'recent']),
  };
  const compiler = makeCompiler(templates);
  const compiled = new Map();
  let interpretOnly = false;
  const renderer = (name, kind) => {
    const key = `${kind}\u0000${name}`;
    let r = compiled.get(key);
    if (r !== undefined) return r;
    const nodes = templates.get(name);
    if (nodes === undefined) r = null;
    else {
      if (!interpretOnly) {
        try {
          r = compiler.layout(name, ROOTS[kind]);
        } catch (err) {
          if (!(err instanceof Overflow) && !(err instanceof RangeError)) throw err;
          interpretOnly = true;
        }
      }
      if (interpretOnly) r = (vars) => interpret(nodes, { vars, parent: null }, templates, 0);
    }
    compiled.set(key, r);
    return r;
  };
  const render = (name, kind, vars) => {
    const r = renderer(name, kind);
    return r === null ? null : r(vars);
  };

  const output = {};
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: s.post ? card.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url })) : card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, 'page', { site, tags: allTags, recent, page });
  }
  const per = input.site.per_page;
  const nPages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= nPages; k++) {
    const html = render('index', 'index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: nPages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === nPages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', 'tag', { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', 'tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = report.concat([...broken]).sort(byCodeUnits);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
