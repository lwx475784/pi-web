// Text glue for dictation: joining transcript segments into a draft without
// inserting spaces a terminal editor would not add (CJK scripts take none).

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const WORD_EDGE = /[A-Za-z0-9]/;

/**
 * The text to insert for `segment` after `existing` (the draft prefix before
 * the caret). Latin-to-latin joins get a space; CJK runs join flush, matching
 * how people write Chinese without word separators. Whitespace already present
 * is kept as-is.
 */
export function joinTranscript(existing: string, segment: string): string {
  const seg = segment.trim();
  if (!seg) return "";
  if (!existing) return seg;
  if (/\s$/.test(existing)) return seg;
  const last = existing[existing.length - 1];
  const first = seg[0];
  const latinBothSides = WORD_EDGE.test(last) && WORD_EDGE.test(first);
  if (latinBothSides) return ` ${seg}`;
  if (CJK.test(last) || CJK.test(first)) return seg;
  return ` ${seg}`;
}
