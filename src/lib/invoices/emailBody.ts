// Pure. The email body - a small plain HTML table of the same
// facts as the coding page. No V2 links (accounting cannot sign
// in). Styling is minimal and inline.

import type { CodingPageData } from "./codingPageData";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildEmailBody(d: CodingPageData): string {
  const esc = escapeHtml;
  const rows: string[] = [];

  const kv = (label: string, value: string): string =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555;">${esc(label)}</td><td style="padding:4px 0;">${esc(value)}</td></tr>`;

  if (d.isTest) {
    rows.push(`<tr><td colspan="2" style="padding:0 0 12px 0;font-weight:bold;">[TEST]</td></tr>`);
  }
  rows.push(kv("Site", d.site));
  rows.push(kv("Vendor", d.vendor));
  rows.push(kv(d.numberLabel, d.number));
  rows.push(kv(d.dateLabel, d.dateDisplay));
  rows.push(kv(d.totalLabel, d.totalDisplay));

  const codingBody = d.lines.length === 0
    ? `<tr><td colspan="3" style="padding:4px 0;color:#555;">(no lines)</td></tr>`
    : d.lines.map((l) => (
        `<tr>` +
          `<td style="padding:4px 12px 4px 0;">${esc(l.code)}</td>` +
          `<td style="padding:4px 12px 4px 0;">${esc(l.name)}</td>` +
          `<td style="padding:4px 0;text-align:right;">${esc(l.amountDisplay)}</td>` +
        `</tr>`
      )).join("");

  const foot: string[] = [];
  if (d.byline) foot.push(`Sent by ${esc(d.byline)}.`);
  foot.push(`Sent ${esc(d.whenDisplay)}.`);

  return [
    `<!doctype html>`,
    `<html><body style="font-family:Helvetica,Arial,sans-serif;color:#1B2637;">`,
    `<p style="margin:0 0 16px 0;font-size:18px;"><strong>${esc(d.kindLabel)}</strong></p>`,
    `<table style="border-collapse:collapse;font-size:14px;">${rows.join("")}</table>`,
    `<h3 style="margin:16px 0 4px 0;font-size:14px;">Coding</h3>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    `<thead><tr>` +
      `<th style="text-align:left;padding:4px 12px 4px 0;color:#555;">Code</th>` +
      `<th style="text-align:left;padding:4px 12px 4px 0;color:#555;">Name</th>` +
      `<th style="text-align:right;padding:4px 0;color:#555;">Amount</th>` +
      `</tr></thead>`,
    `<tbody>${codingBody}</tbody>`,
    `</table>`,
    `<p style="margin:16px 0 0 0;font-size:12px;color:#555;">${foot.join(" ")}</p>`,
    `</body></html>`,
  ].join("");
}
