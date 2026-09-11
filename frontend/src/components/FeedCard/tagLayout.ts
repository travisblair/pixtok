// Tag-row measurement — extracted from FeedCard. Pure DOM bucketing:
// chips are grouped into their natural visual rows by offsetTop, then
// re-packed onto two interleaved lines when the wrap needs more than
// two rows (the fixed-height two-line strip scrolls horizontally).
import type { TagPair } from "../../helpers";

export interface TagLines {
  top: TagPair[];
  bottom: TagPair[];
}

/**
 * Bucket chips into rows by offsetTop; if the tags need MORE than two
 * rows, re-pack onto two interleaved lines (rows 1,3,5→top;
 * 2,4,6→bottom) so reading order stays row-major. Returns null when the
 * natural wrap already fits the two-line strip (including no chips).
 */
export function computeTagLines(
  chips: readonly HTMLElement[],
  pairs: readonly TagPair[]
): TagLines | null {
  if (chips.length === 0) return null;
  let prevTop: number | null = null;
  const rows: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < chips.length; i++) {
    const top = chips[i].offsetTop;
    if (prevTop === null || top === prevTop) {
      cur.push(i);
    } else {
      rows.push(cur);
      cur = [i];
    }
    prevTop = top;
  }
  rows.push(cur);
  if (rows.length <= 2) return null; // natural wrap already correct
  const top: TagPair[] = [];
  const bottom: TagPair[] = [];
  rows.forEach((row, ri) => {
    const target = ri % 2 === 0 ? top : bottom;
    for (const i of row) target.push(pairs[i]);
  });
  return { top, bottom };
}
