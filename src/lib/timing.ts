// T4 §4: one-line structured timing log per request so the next slow
// thing can be read from logs instead of guessed. Shape:
//   { t: "timing", route, total_ms, stages: { gate, item, batch1, ... } }
// No user data, no ids, no emails: route is a static string, stages
// carry integer milliseconds. Call startTimer() at the top of the
// handler (before the auth gate), mark() between phases, then end().
//
// Server components and API routes share the same helper so the log
// shape is one grep.

type Timer = {
  readonly route: string;
  readonly t0: number;
  readonly marks: Record<string, number>;
};

export function startTimer(route: string): Timer {
  return { route, t0: Date.now(), marks: {} };
}

// Stamp a named stage. The duration recorded is the time since the
// previous mark (or since start when this is the first mark), so the
// stages add up to total_ms without the caller doing subtraction.
export function mark(timer: Timer, stage: string): void {
  const now = Date.now();
  const prior = Object.values(timer.marks).reduce((s, n) => s + n, 0);
  const elapsed = now - timer.t0 - prior;
  timer.marks[stage] = elapsed >= 0 ? elapsed : 0;
}

// Emit the one-line log. Call at the END of the handler, after every
// stage has been marked. total_ms is the wall clock from start to now;
// stages is the accumulated map. Nothing fancy: a single console.log
// with a JSON payload so the Vercel log viewer can filter on t=timing.
export function endTimer(timer: Timer, extra?: Record<string, unknown>): void {
  const total_ms = Date.now() - timer.t0;
  const line: Record<string, unknown> = {
    t: "timing",
    route: timer.route,
    total_ms,
    stages: timer.marks,
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) line[k] = v;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
