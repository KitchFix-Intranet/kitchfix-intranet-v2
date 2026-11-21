// Pure. Pagination for the coding page.
//
// Fix 3: when the coding lines pass the bottom of the first
// coding page, start another page with the column heads
// repeated. The renderer calls this to lay out its pages; the
// return is the data each page should draw. "The data the page
// draws" - which the test asserts on.

export interface PaginatedLines<L> {
  pages: L[][];
}

// Partition `lines` into pages. The first page gets `firstPageCap`
// rows (the header, the five labelled rows and the "Coding" title
// + column heads take the rest of its room). Every page after
// the first gets `fullPageCap` rows (only the column heads take
// room above). Order is preserved; no line is dropped.
export function paginateCodingLines<L>(
  lines: ReadonlyArray<L>,
  firstPageCap: number,
  fullPageCap: number,
): PaginatedLines<L> {
  if (firstPageCap < 1) throw new Error("firstPageCap must be >= 1");
  if (fullPageCap < 1) throw new Error("fullPageCap must be >= 1");

  const pages: L[][] = [];
  if (lines.length === 0) {
    pages.push([]);
    return { pages };
  }

  // First page.
  const firstSlice = lines.slice(0, Math.min(firstPageCap, lines.length));
  pages.push(firstSlice.slice());
  let i = firstSlice.length;

  // Subsequent full pages.
  while (i < lines.length) {
    const end = Math.min(i + fullPageCap, lines.length);
    pages.push(lines.slice(i, end).slice());
    i = end;
  }

  return { pages };
}
