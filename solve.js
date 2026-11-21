// Fast drop-in for csv-reader 1.0.0.
// Strategy: jump between delimiters with String.indexOf and take whole fields
// - A quoted field is scanned for the next quote / CR / line end the same
//   way; the record's line end is the newline bound, so a scan costs one
//   indexOf (for '"') instead of two. CRs and LFs inside quotes become LF
//   and count as lines. Output is identical to csv-reader 1.0.0.
//
// Speed notes:
// - A bare indexOf('\r', p) scans to the end of the text when there is no CR
//   nearby, which is O(n) per field. The CR position is therefore cached
//   (peekCR): the search start only moves forward, so all CR scanning across
//   the whole parse is amortised O(n). When the text holds no CR at all
//   (hasCR false) the CR checks are skipped outright.
// - An unquoted field ends at the next comma or at its record's line end.
//   The line end is computed once per record (the fast-path check already
//   finds it) and reused as a bound, so an unquoted field costs one indexOf
//   (for ',') instead of two (',' and '\n'). After a quoted field — which
//   may hold an embedded newline — the line end is recomputed.
// - A clean line (no quotes, no stray CRs) is one record whose fields are
//   just the line split on commas.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Whether the text holds any CR at all; when it does not, every CR check
  // below is skipped.
  const hasCR = text.indexOf('\r') !== -1;

  // Position of the next '\r' at or after the last search start, or -1 when a
  // search from a position at or before the current one found none, or -2
  // when no search has run yet. The parse only moves forward, so a cached
  // position behind the current scan point is stale and triggers a re-search
  // from the current point; total CR scanning is amortised O(n).
  let nextCR = -2;
  function peekCR(from) {
    if (nextCR === -2 || (nextCR >= 0 && nextCR < from)) {
      nextCR = text.indexOf('\r', from);
    }
    return nextCR;
  }

  // The next '\n' at or after the current record's start (n when there is
  // none): the bound an unquoted field ends at. Recomputed after a quoted
  // field, which may hold an embedded newline.
  let lineEnd = n;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  function readUnquoted(value) {
    let added = 0;
    let parts = null;
    let p = pos;
    // The line-end bound must never lie behind the field start (a quoted
    // field with an embedded newline can leave it stale); recompute it.
    if (lineEnd < p) {
      const nl = text.indexOf('\n', p);
      lineEnd = nl === -1 ? n : nl;
    }
    while (true) {
      const iC = text.indexOf(',', p);
      // The field ends at the nearer of the next comma and the line end.
      let m = lineEnd;
      if (iC !== -1 && iC < m) m = iC;
      // A CR before m is either a stray CR (drop + error, field continues)
      // or, when it sits immediately before the LF that ends the field, the
      // CRLF line ending itself.
      if (hasCR) {
        const cr = peekCR(p);
        if (cr !== -1 && cr < m) {
          if (cr === m - 1 && m === lineEnd && lineEnd < n) {
            const tail = text.slice(p, cr);
            added += tail.length;
            if (parts) { parts.push(tail); value = parts.join(''); }
            else value += tail;
            pos = lineEnd + 1;
            line += 1;
            return { value, ended: LINE_BREAK, added };
          }
          error('stray_cr');
          const tail = text.slice(p, cr);
          added += tail.length;
          if (parts === null) parts = [value, tail];
          else parts.push(tail);
          p = cr + 1;
          continue;
        }
      }
      if (m === lineEnd) {
        // The field ends at the line end (or at EOF when lineEnd is n).
        const tail = text.slice(p, m);
        added += tail.length;
        if (parts) { parts.push(tail); value = parts.join(''); }
        else value += tail;
        if (lineEnd >= n) {
          pos = n;
          return { value, ended: END, added };
        }
        pos = lineEnd + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // The field ends at a comma.
      const tail = text.slice(p, m);
      added += tail.length;
      if (parts) { parts.push(tail); value = parts.join(''); }
      else value += tail;
      pos = m + 1;
      return { value, ended: COMMA, added };
    }
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let p = pos + 1;
    let chunkStart = p;
    let closed = false;
    let value = '';
    while (p < n) {
      // The line-end bound must never lie behind the scan point (a CRLF
      // inside quotes can leave it stale); recompute it.
      if (lineEnd < p) {
        const nl0 = text.indexOf('\n', p);
        lineEnd = nl0 === -1 ? n : nl0;
      }
      const iQ = text.indexOf('"', p);
      let m = n;
      if (iQ !== -1) m = iQ;
      if (lineEnd < m) m = lineEnd;
      let cr = -1;
      if (hasCR) {
        cr = peekCR(p);
        if (cr !== -1 && cr < m) m = cr;
      }
      if (m === n) break;
      if (m === iQ) {
        if (m + 1 < n && text[m + 1] === '"') {
          if (parts === null) parts = [];
          parts.push(text.slice(chunkStart, m));
          parts.push('"');
          p = m + 2;
          chunkStart = p;
          continue;
        }
        closed = true;
        if (parts === null) value = text.slice(chunkStart, m);
        else { parts.push(text.slice(chunkStart, m)); value = parts.join(''); }
        pos = m + 1;
        break;
      }
      if (m === cr) {
        if (parts === null) parts = [];
        parts.push(text.slice(chunkStart, m));
        parts.push('\n');
        line += 1;
        p = (m + 1 < n && text[m + 1] === '\n') ? m + 2 : m + 1;
        chunkStart = p;
        continue;
      }
      // m === lineEnd: an LF inside quotes becomes LF and counts a line.
      if (parts === null) parts = [];
      parts.push(text.slice(chunkStart, m));
      parts.push('\n');
      line += 1;
      p = m + 1;
      chunkStart = p;
      const nl = text.indexOf('\n', p);
      lineEnd = nl === -1 ? n : nl;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      // The parse moved backward: the CR cache was advanced by the failed
      // quoted scan, so it must be invalidated and re-searched from here.
      nextCR = -2;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') { pos += 1; return { value, ended: COMMA }; }
    if (c === '\n') { pos += 1; line += 1; return { value, ended: LINE_BREAK }; }
    if (c === '\r' && pos + 1 < n && text[pos + 1] === '\n') { pos += 2; line += 1; return { value, ended: LINE_BREAK }; }
    // The junk after the closing quote is read as unquoted. The quoted field
    // may have held an embedded newline, so the line-end bound from the
    // record's start can be stale (behind pos); recompute it first.
    const nl = text.indexOf('\n', pos);
    lineEnd = nl === -1 ? n : nl;
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Finish one record's fields: set the width from the first record, take the
  // header, or pad/cut to the width and push the row. Returns false when the
  // record is skipped (a line that held only stray CRs).
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return false;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return true;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
    return true;
  }

  while (true) {
    while (pos < n) {
      const c = text[pos];
      if (c === '\n') { pos += 1; line += 1; }
      else if (c === '\r' && pos + 1 < n && text[pos + 1] === '\n') { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;

    // The record's line end, reused as the bound for its unquoted fields.
    const iL = text.indexOf('\n', pos);
    lineEnd = iL === -1 ? n : iL;

    // Fast path: a clean line — no quotes and no stray CRs — is one record
    // whose fields are just the line split on commas.
    let contentEnd = lineEnd;
    if (hasCR && lineEnd > pos && lineEnd < n && text[lineEnd - 1] === '\r') contentEnd = lineEnd - 1;
    const iQ = text.indexOf('"', pos);
    const cr = hasCR ? peekCR(pos) : -1;
    if ((iQ === -1 || iQ >= contentEnd) && (cr === -1 || cr >= contentEnd)) {
      // Clean line: no quotes, no stray CRs (the CRLF CR, if any, is excluded
      // from the content). An empty line is no record.
      if (contentEnd === pos) {
        pos = lineEnd < n ? lineEnd + 1 : n;
        line += 1;
        continue;
      }
      const fields = text.slice(pos, contentEnd).split(',');
      finishRecord(fields, false);
      pos = lineEnd < n ? lineEnd + 1 : n;
      line += 1;
      continue;
    }

    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
      // A quoted field may hold an embedded newline, so the line end bound
      // is recomputed after one.
      if (quoted) {
        const nl = text.indexOf('\n', pos);
        lineEnd = nl === -1 ? n : nl;
      }
    } while (field.ended === COMMA);

    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
