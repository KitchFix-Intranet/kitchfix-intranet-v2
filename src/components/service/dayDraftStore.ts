// localStorage wrappers for the day form.
//
// Rule 17 (nothing lost): every keystroke writes a draft keyed by
// (accountKey, serviceDate). Back closes the drawer by URL; re-open
// finds the draft and offers Keep them / Clear them.
//
// Rule 16 (slipped-digit): when the user keeps a value at 3x+ its
// projection, that (accountKey, serviceDate, serviceId, value) tuple
// is written so the question never asks twice about the same number.
//
// Private-mode safe: every read + write wraps in try/catch. When
// storage is blocked, a per-session in-memory fallback carries the
// drafts until the browser is closed.

const DRAFT_KEY = "kf-sc-drafts-v2";
const KEPT_KEY  = "kf-sc-kept-v2";

type CountsMap = Record<string, number | null>;

export interface DayDraft {
  counts: CountsMap;    // serviceId -> actualCount or null (ghosted)
  addedServiceIds: string[]; // services added via "Add a service"
  at: string;           // ISO timestamp of the last keystroke
}

const memDraft = new Map<string, DayDraft>();
const memKept  = new Map<string, number>();

function hasStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const t = "__kf_probe__";
    window.localStorage.setItem(t, "1");
    window.localStorage.removeItem(t);
    return true;
  } catch { return false; }
}

function keyFor(accountKey: string, serviceDate: string): string {
  return `${accountKey}|${serviceDate}`;
}

function keptKeyFor(accountKey: string, serviceDate: string, serviceId: string): string {
  return `${accountKey}|${serviceDate}|${serviceId}`;
}

// ── drafts ──

function readAllDrafts(): Record<string, DayDraft> {
  if (!hasStorage()) return Object.fromEntries(memDraft);
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeAllDrafts(store: Record<string, DayDraft>) {
  if (!hasStorage()) { memDraft.clear(); for (const [k, v] of Object.entries(store)) memDraft.set(k, v); return; }
  try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(store)); } catch { /* memory only */ }
}

export function readDraft(accountKey: string, serviceDate: string): DayDraft | null {
  const all = readAllDrafts();
  return all[keyFor(accountKey, serviceDate)] ?? null;
}

export function writeDraft(accountKey: string, serviceDate: string, draft: DayDraft): void {
  const all = readAllDrafts();
  all[keyFor(accountKey, serviceDate)] = draft;
  writeAllDrafts(all);
}

export function clearDraft(accountKey: string, serviceDate: string): void {
  const all = readAllDrafts();
  delete all[keyFor(accountKey, serviceDate)];
  writeAllDrafts(all);
}

// ── kept slipped-digit numbers ──

function readAllKept(): Record<string, number> {
  if (!hasStorage()) return Object.fromEntries(memKept);
  try {
    const raw = window.localStorage.getItem(KEPT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeAllKept(store: Record<string, number>) {
  if (!hasStorage()) { memKept.clear(); for (const [k, v] of Object.entries(store)) memKept.set(k, v); return; }
  try { window.localStorage.setItem(KEPT_KEY, JSON.stringify(store)); } catch { /* memory only */ }
}

export function isKept(accountKey: string, serviceDate: string, serviceId: string, value: number): boolean {
  const all = readAllKept();
  return all[keptKeyFor(accountKey, serviceDate, serviceId)] === value;
}

export function markKept(accountKey: string, serviceDate: string, serviceId: string, value: number): void {
  const all = readAllKept();
  all[keptKeyFor(accountKey, serviceDate, serviceId)] = value;
  writeAllKept(all);
}
