// R-PP10 contact rule enforcement. Pin 3 (2026-11-11):
//
//   - Work email: shown for anyone who has one.
//   - Personal email: selected ONLY when the person has no work
//     email AND is not salaried; shown ONLY on the card, never in
//     a roster row, search result or any list payload.
//   - Phone (salaried): printed on the card. `phone_for_display`.
//   - Phone (hourly): never printed as visible text. Powers Call
//     and Text buttons via tel: and sms: hrefs only.
//
// Rule of thumb: `RosterPerson` MUST NEVER carry personal_email or
// phone. If you need either, you are rendering a `CardPerson`.
//
// The two mappers below are the single point where the fields are
// stripped. Every loader goes through them. Do not construct a
// `RosterPerson` or `CardPerson` by hand.

import type { PeopleRow, RosterPerson, CardPerson, WaitingItem, HistoryRow } from "./types";

// T2.1 fix 1 (2026-11-12). people.phone arrives as
// "tel:+1-312-555-0100". Never trust the shape - strip a leading
// "tel:" and every non-digit, accept 10 digits or 11 starting with
// 1, return the href-ready form + the display form. Anything that
// does not parse: null (caller falls back to the disabled state).
// Exported standalone so a probe can hit it; the only caller is
// toCardPerson() below.
export function normalisePhone(raw: string | null | undefined): { href: string; display: string } | null {
  const digits = (raw ?? "").replace(/^tel:/i, "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  return {
    href: `+1${ten}`,
    display: `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`,
  };
}

export function initialsOf(display_name: string | null, work_email: string | null): string {
  const base = (display_name ?? "").trim();
  if (base) {
    const parts = base.split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    const ini = (first + last).toUpperCase();
    if (ini) return ini;
  }
  const local = (work_email ?? "").split("@")[0] ?? "";
  return (local[0] ?? "?").toUpperCase();
}

// ROSTER mapper. The only way to produce a RosterPerson. Drops
// personal_email + phone + start_date + birthday + manager_worker_id
// before the row ever leaves the server. The compile-time shape
// guarantees we cannot forget a field: the output type does not
// carry the stripped columns at all.
export function toRosterPerson(
  row: PeopleRow,
  account_region: string | null,
  waiting: WaitingItem | null,
  waiting_count: number,
): RosterPerson {
  return {
    worker_id: row.worker_id,
    display_name: row.display_name ?? "",
    title: row.title,
    account_key: row.account_key,
    account_region,
    work_email: row.work_email,
    is_corp: !!row.is_corp,
    is_salaried: !!row.is_salaried,
    is_site_leader: !!row.is_site_leader,
    is_regional_director: !!row.is_regional_director,
    initials: initialsOf(row.display_name, row.work_email),
    waiting,
    waiting_count,
  };
}

// CARD mapper. Applies the R-PP10 contact rule explicitly. Call
// sites pass the already-resolved manager name (pin 4) and the
// already-computed tenure / history strings.
export interface ToCardInput {
  row: PeopleRow;
  account_region: string | null;
  waiting: WaitingItem | null;
  waiting_count: number;
  manager_name: string | null;
  started_full: string | null;
  tenure_line: string | null;
  anniversary_line: string | null;
  historyVisible: boolean;
  history: HistoryRow[];
}

export function toCardPerson(input: ToCardInput): CardPerson {
  const { row } = input;
  const roster = toRosterPerson(row, input.account_region, input.waiting, input.waiting_count);

  // Email branch of R-PP10. Personal email is selected only when:
  //   (a) the person has no work email, AND
  //   (b) the person is not salaried.
  // The field exits the server only via personal_email_for_display.
  // row.personal_email is otherwise discarded here.
  const workEmail = (row.work_email ?? "").trim();
  const personalEmail = (row.personal_email ?? "").trim();
  const showPersonalEmail =
    workEmail.length === 0 && !row.is_salaried && personalEmail.length > 0;
  const personal_email_for_display = showPersonalEmail ? personalEmail : null;

  // Phone branch of R-PP10. For salaried: print it + power tel:.
  // For hourly: tel:/sms: hrefs only, never printed. normalisePhone
  // (T2.1 fix 1) parses the stored `tel:+1-###-###-####` shape and
  // yields a tel-safe href + "(###) ###-####" display; anything that
  // does not parse is treated as no phone.
  const norm = normalisePhone(row.phone ?? null);
  const phone_for_display = norm && row.is_salaried ? norm.display : null;
  const phone_href = norm ? norm.href : null;

  return {
    ...roster,
    showPersonalEmail,
    personal_email_for_display,
    phone_for_display,
    phone_href,
    manager_name: input.manager_name,
    started_full: input.started_full,
    tenure_line: input.tenure_line,
    anniversary_line: input.anniversary_line,
    historyVisible: input.historyVisible,
    history: input.history,
  };
}
