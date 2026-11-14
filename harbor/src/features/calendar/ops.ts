// Calendar push: events to /data/calendar.jsonl.
import type { Client } from '../../proto/client';
import { expandIcs, toJsonl, windowAround, type ExpandResult } from '../../lib/ics';

export const CALENDAR_PATH = '/data/calendar.jsonl';
export const ICS_MAX_BYTES = 8 * 1024 * 1024; // refuse silly files before parsing
const enc = new TextEncoder();

export function icsProblem(name: string, size: number): string | null {
  if (!/\.(ics|ical|ifb)$/i.test(name)) return 'Calendar files end in .ics.';
  if (size === 0) return 'That file is empty.';
  if (size > ICS_MAX_BYTES) return 'That calendar file is over 8 MB. Export a shorter range.';
  return null;
}

export async function pushCalendar(
  c: Pick<Client, 'put'>,
  r: ExpandResult,
  source: 'google' | 'ics',
  nowUnix = Math.floor(Date.now() / 1000),
): Promise<void> {
  await c.put(CALENDAR_PATH, enc.encode(toJsonl(r.events, source, nowUnix)));
}

export async function importIcs(
  c: Pick<Client, 'put'>,
  text: string,
  opts: { nowUnix?: number; tz?: string } = {},
): Promise<ExpandResult> {
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const r = expandIcs(text, { window: windowAround(now), tz: opts.tz });
  await pushCalendar(c, r, 'ics', now);
  return r;
}
