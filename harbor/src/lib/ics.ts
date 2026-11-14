// iCalendar (.ics) to the device calendar schema (plan 3.2): events as {s,e,all,t,loc,d}, recurrences expanded into
// the window, at most 2000 events. Pure and synchronous.
//
// Supported: RRULE FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (weekly, monthly with ordinals),
// BYMONTHDAY; EXDATE; RECURRENCE-ID overrides; all-day events; TZID, UTC and floating times; DURATION.
// ponytail: no RDATE, BYSETPOS, BYWEEKNO or BYYEARDAY; unknown rules expand like their plain FREQ. Upgrade path: a full RFC 5545 expander.

export const MAX_EVENTS = 2000;
export const WINDOW_BEFORE_DAYS = 7;
export const WINDOW_AFTER_DAYS = 90;
const MAX_CANDIDATES = 20000;

export interface CalEvent {
  s: number;
  e: number;
  all: boolean;
  t: string;
  loc: string;
  d: string;
}

export interface Window {
  from: number;
  to: number;
}

export function windowAround(nowUnix: number): Window {
  return { from: nowUnix - WINDOW_BEFORE_DAYS * 86400, to: nowUnix + WINDOW_AFTER_DAYS * 86400 };
}

export interface ExpandResult {
  events: CalEvent[];
  /** true when more than MAX_EVENTS fell inside the window and the later ones were dropped. */
  truncated: boolean;
}

export function systemTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ---- time zones ------------------------------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (fmtCache.has(tz)) return fmtCache.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    f = null; // unknown zone name
  }
  fmtCache.set(tz, f);
  return f;
}

function offsetMs(tz: string, utcMs: number): number {
  if (tz === 'UTC') return 0;
  const f = formatter(tz);
  if (!f) return 0;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(Math.floor(utcMs / 1000) * 1000))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock fields in a zone to unix seconds. Gaps and overlaps resolve to the earlier valid instant. */
export function wallToUnix(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = offsetMs(tz, guess);
  let t = guess - o1;
  const o2 = offsetMs(tz, t);
  if (o2 !== o1) t = guess - o2;
  return Math.floor(t / 1000);
}

// ---- parsing ---------------------------------------------------------------------------------------------------

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of raw) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) out[out.length - 1] += l.slice(1);
    else out.push(l);
  }
  return out.filter((l) => l.length > 0);
}

function parseLine(line: string): Prop | null {
  // Split at the first colon outside double quotes.
  let q = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs: string[] = [];
  let cur = '';
  q = false;
  for (const c of head) {
    if (c === '"') q = !q;
    if (c === ';' && !q) {
      segs.push(cur);
      cur = '';
    } else cur += c;
  }
  segs.push(cur);
  const params: Record<string, string> = {};
  for (const s of segs.slice(1)) {
    const eq = s.indexOf('=');
    if (eq > 0) params[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: segs[0]!.toUpperCase(), params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

interface When {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  all: boolean;
  tz: string; // zone the wall fields are in ('UTC' for Z values)
}

function parseWhen(p: Prop, defTz: string): When | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(p.value.trim());
  if (!m) return null;
  const all = p.params.VALUE === 'DATE' || m[4] === undefined;
  const utc = m[7] === 'Z';
  let tz = utc ? 'UTC' : p.params.TZID ?? defTz;
  if (!utc && p.params.TZID && !formatter(tz)) tz = defTz; // Windows zone names etc.: use the device zone
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), all, tz };
}

function whenToUnix(w: When, defTz: string): number {
  return w.all ? wallToUnix(w.y, w.mo, w.d, 0, 0, 0, defTz) : wallToUnix(w.y, w.mo, w.d, w.h, w.mi, w.s, w.tz);
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const sec = +(m[2] ?? 0) * 604800 + +(m[3] ?? 0) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0);
  return m[1] === '-' ? -sec : sec;
}

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: When | null;
  byday: Array<{ n: number; wd: number }>; // wd 0=MO..6=SU, n=0 for every
  bymonthday: number[];
  bymonth: number[];
  wkst: number;
}

const WD = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function parseRule(v: string, defTz: string): Rule | null {
  const kv: Record<string, string> = {};
  for (const part of v.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const freq = kv.FREQ as Rule['freq'] | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null; // HOURLY etc.: not supported
  const byday: Rule['byday'] = [];
  for (const tok of (kv.BYDAY ?? '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(tok.trim().toUpperCase());
    if (m) byday.push({ n: m[1] ? parseInt(m[1], 10) : 0, wd: WD.indexOf(m[2]!) });
  }
  const nums = (s?: string) => (s ?? '').split(',').filter(Boolean).map(Number).filter(Number.isFinite);
  return {
    freq,
    interval: Math.max(1, parseInt(kv.INTERVAL ?? '1', 10) || 1),
    count: kv.COUNT ? Math.max(0, parseInt(kv.COUNT, 10) || 0) : null,
    until: kv.UNTIL ? parseWhen({ name: 'UNTIL', params: {}, value: kv.UNTIL }, defTz) : null,
    byday,
    bymonthday: nums(kv.BYMONTHDAY),
    bymonth: nums(kv.BYMONTH),
    wkst: Math.max(0, WD.indexOf((kv.WKST ?? 'MO').toUpperCase())),
  };
}

// ---- expansion -------------------------------------------------------------------------------------------------

/** Days since 1970-01-01 for a civil date (also accepts out-of-range months/days; Date.UTC normalises). */
const dayNum = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
const civil = (n: number): [number, number, number] => {
  const t = new Date(n * 86400000);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};
const weekday = (n: number) => (((n + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0=MO
const dim = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** Candidate start dates (day numbers) of a rule in order, from dtstart's date. Generator, bounded by the caller. */
function* candidates(r: Rule, start: When): Generator<number> {
  const sd = dayNum(start.y, start.mo, start.d);
  const swd = weekday(sd);
  if (r.freq === 'DAILY') {
    for (let k = 0; ; k++) {
      const n = sd + k * r.interval;
      if (r.bymonth.length && !r.bymonth.includes(civil(n)[1])) continue;
      if (r.byday.length && !r.byday.some((b) => b.wd === weekday(n))) continue;
      yield n;
    }
  } else if (r.freq === 'WEEKLY') {
    const wds = r.byday.length ? r.byday.map((b) => b.wd) : [swd];
    const wkStart = sd - ((swd - r.wkst + 7) % 7);
    for (let k = 0; ; k++) {
      const base = wkStart + k * 7 * r.interval;
      const days = wds.map((w) => base + ((w - r.wkst + 7) % 7)).sort((a, b) => a - b);
      for (const n of days) if (n >= sd) yield n;
    }
  } else if (r.freq === 'MONTHLY') {
    for (let k = 0; ; k++) {
      const total = start.y * 12 + (start.mo - 1) + k * r.interval;
      const y = Math.floor(total / 12);
      const mo = (total % 12) + 1;
      if (r.bymonth.length && !r.bymonth.includes(mo)) continue;
      const len = dim(y, mo);
      const out = new Set<number>();
      if (r.byday.length) {
        for (const b of r.byday) {
          const all: number[] = [];
          for (let d = 1; d <= len; d++) if (weekday(dayNum(y, mo, d)) === b.wd) all.push(d);
          if (b.n === 0) all.forEach((d) => out.add(d));
          else {
            const d = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
            if (d !== undefined) out.add(d);
          }
        }
        if (r.bymonthday.length) for (const d of [...out]) if (!r.bymonthday.some((m) => (m > 0 ? m : len + 1 + m) === d)) out.delete(d);
      } else {
        const mds = r.bymonthday.length ? r.bymonthday : [start.d];
        for (const m of mds) {
          const d = m > 0 ? m : len + 1 + m;
          if (d >= 1 && d <= len) out.add(d);
        }
      }
      for (const d of [...out].sort((a, b) => a - b)) {
        const n = dayNum(y, mo, d);
        if (n >= sd) yield n;
      }
    }
  } else {
    for (let k = 0; ; k++) {
      const y = start.y + k * r.interval;
      const months = r.bymonth.length ? r.bymonth : [start.mo];
      for (const mo of [...months].sort((a, b) => a - b)) {
        const len = dim(y, mo);
        const mds = r.bymonthday.length ? r.bymonthday : [start.d];
        for (const m of [...mds].sort((a, b) => a - b)) {
          const d = m > 0 ? m : len + 1 + m;
          if (d < 1 || d > len) continue; // Feb 29 in a common year is skipped
          const n = dayNum(y, mo, d);
          if (n >= sd) yield n;
        }
      }
    }
  }
}

interface Raw {
  uid: string;
  start: When;
  startUnix: number;
  durSec: number; // timed events
  days: number; // all-day events: length in days
  t: string;
  loc: string;
  d: string;
  rule: Rule | null;
  exdates: Set<number>;
  recId: number | null;
}

function parseEvents(text: string, defTz: string): Raw[] {
  const lines = unfold(text);
  const out: Raw[] = [];
  let cur: Prop[] | null = null;
  for (const l of lines) {
    const up = l.toUpperCase();
    if (up === 'BEGIN:VEVENT') cur = [];
    else if (up === 'END:VEVENT') {
      if (cur) {
        const r = buildRaw(cur, defTz);
        if (r) out.push(r);
      }
      cur = null;
    } else if (cur) {
      // Nested components (VALARM) carry their own DESCRIPTION: skip until their END.
      if (up.startsWith('BEGIN:')) {
        cur.push({ name: 'BEGIN', params: {}, value: up.slice(6) });
        continue;
      }
      if (up.startsWith('END:')) {
        cur.push({ name: 'END', params: {}, value: up.slice(4) });
        continue;
      }
      const p = parseLine(l);
      if (p) cur.push(p);
    }
  }
  return out;
}

function buildRaw(props: Prop[], defTz: string): Raw | null {
  const top: Prop[] = [];
  let depth = 0;
  for (const p of props) {
    if (p.name === 'BEGIN') depth++;
    else if (p.name === 'END') depth = Math.max(0, depth - 1);
    else if (depth === 0) top.push(p);
  }
  const first = (n: string) => top.find((p) => p.name === n);
  if (first('STATUS')?.value.trim().toUpperCase() === 'CANCELLED') return null;
  const ds = first('DTSTART');
  const start = ds ? parseWhen(ds, defTz) : null;
  if (!start) return null;
  const startUnix = whenToUnix(start, defTz);
  let durSec = 0;
  let days = 1;
  const de = first('DTEND');
  const du = first('DURATION');
  if (de) {
    const end = parseWhen(de, defTz);
    if (end) {
      if (start.all) days = Math.max(1, dayNum(end.y, end.mo, end.d) - dayNum(start.y, start.mo, start.d));
      else durSec = Math.max(0, whenToUnix(end, defTz) - startUnix);
    }
  } else if (du) {
    const s = parseDuration(du.value);
    if (s !== null) {
      if (start.all) days = Math.max(1, Math.round(s / 86400));
      else durSec = Math.max(0, s);
    }
  }
  const rr = first('RRULE');
  const exdates = new Set<number>();
  for (const p of top) {
    if (p.name !== 'EXDATE') continue;
    for (const v of p.value.split(',')) {
      const w = parseWhen({ ...p, value: v }, defTz);
      if (w) exdates.add(whenToUnix(w, defTz));
    }
  }
  const rid = first('RECURRENCE-ID');
  const ridW = rid ? parseWhen(rid, defTz) : null;
  return {
    uid: first('UID')?.value.trim() ?? '',
    start,
    startUnix,
    durSec,
    days,
    t: unescapeText(first('SUMMARY')?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(no title)',
    loc: unescapeText(first('LOCATION')?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    d: unescapeText(first('DESCRIPTION')?.value ?? '').trim().slice(0, 500),
    rule: rr ? parseRule(rr.value, defTz) : null,
    exdates,
    recId: ridW ? whenToUnix(ridW, defTz) : null,
  };
}

function instance(r: Raw, n: number, defTz: string): { s: number; e: number } {
  const [y, mo, d] = civil(n);
  if (r.start.all) {
    const [y2, mo2, d2] = civil(n + r.days);
    return { s: wallToUnix(y, mo, d, 0, 0, 0, defTz), e: wallToUnix(y2, mo2, d2, 0, 0, 0, defTz) };
  }
  const s = wallToUnix(y, mo, d, r.start.h, r.start.mi, r.start.s, r.start.tz);
  return { s, e: s + r.durSec };
}

export interface IcsOptions {
  /** Zone for all-day events and floating times; default the browser's. */
  tz?: string;
  window: Window;
}

export function expandIcs(text: string, opts: IcsOptions): ExpandResult {
  const tz = opts.tz ?? systemTz();
  const { from, to } = opts.window;
  const raws = parseEvents(text, tz);
  // Overridden instances of a series are replaced by the override event (which stands alone).
  const overridden = new Map<string, Set<number>>();
  for (const r of raws) {
    if (r.recId !== null) {
      const set = overridden.get(r.uid) ?? new Set<number>();
      set.add(r.recId);
      overridden.set(r.uid, set);
    }
  }
  const out: CalEvent[] = [];
  const push = (r: Raw, s: number, e: number) => {
    const inside = e > s ? e > from && s < to : s >= from && s < to; // overlap; zero-length events must start inside
    if (!inside) return;
    out.push({ s, e, all: r.start.all, t: r.t, loc: r.loc, d: r.d });
  };
  for (const r of raws) {
    if (!r.rule || r.recId !== null) {
      const { s, e } = instance(r, dayNum(r.start.y, r.start.mo, r.start.d), tz);
      push(r, s, e);
      continue;
    }
    const skip = overridden.get(r.uid);
    let emitted = 0;
    let seen = 0;
    const until = r.rule.until;
    let untilUnix = Infinity;
    if (until) untilUnix = until.all ? wallToUnix(until.y, until.mo, until.d + 1, 0, 0, 0, until.tz === 'UTC' ? tz : until.tz) - 1 : whenToUnix(until, tz);
    for (const n of candidates(r.rule, r.start)) {
      if (++seen > MAX_CANDIDATES) break;
      if (r.rule.count !== null && emitted >= r.rule.count) break;
      const { s, e } = instance(r, n, tz);
      if (s > untilUnix) break;
      if (s >= to) break;
      emitted++; // COUNT includes excluded instances
      if (r.exdates.has(s) || skip?.has(s)) continue;
      push(r, s, e);
    }
  }
  out.sort((a, b) => a.s - b.s || a.t.localeCompare(b.t));
  return { events: out.slice(0, MAX_EVENTS), truncated: out.length > MAX_EVENTS };
}

/** Header line plus one JSON line per event (plan 3.2 calendar.jsonl). */
export function toJsonl(events: CalEvent[], source: 'google' | 'ics', nowUnix: number): string {
  const lines = [JSON.stringify({ v: 1, synced: nowUnix, source })];
  for (const e of events.slice(0, MAX_EVENTS)) lines.push(JSON.stringify({ s: e.s, e: e.e, all: e.all, t: e.t, loc: e.loc, d: e.d }));
  return lines.join('\n') + '\n';
}
