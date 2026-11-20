// Train 2b fix 1 / 2.3. Pure.
//
// `check()` must not run against what the server had before the
// newest typing. The old code called flush() which returned at
// once when a save was in flight, so a staged keystroke never
// reached the server and the check looked at stale state (e.g.
// "Type the total" on a filled box).
//
// The fix: wait on the save itself, not a fixed sleep. This file
// carries the small pure piece - a decision function and a
// promise-based queue helper - so the behaviour can be tested
// without a browser. The component owns the real refs; this file
// only knows "in flight", "staged keys", "stopped".

export interface CheckDecisionState {
  inFlight: boolean;
  stagedKeys: number;
  stopped: boolean;
}

export type CheckDecision = "run" | "stop" | "wait";

// Pure. Given the save loop's current state, what should check()
// do right now?
//   - "stop":  the save loop gave up. Do not run the check; the
//              save line already says why.
//   - "wait":  there is work in progress or queued. Wait for it.
//   - "run":   the queue is settled. Safe to call /check.
export function decideCheckAction(s: CheckDecisionState): CheckDecision {
  if (s.stopped) return "stop";
  if (s.inFlight || s.stagedKeys > 0) return "wait";
  return "run";
}

// Signals the waiter needs from the save loop. The component
// supplies these: `getState()` reads the refs, `onSettled(fn)`
// registers a one-shot listener that fires after each tick of
// save-loop work. Returning an unsubscribe keeps the Set clean.
export interface SaveWaitSignals {
  getState: () => CheckDecisionState;
  onSettled: (fn: () => void) => () => void;
}

// Waits until decideCheckAction stops returning "wait", then
// resolves with the terminal decision. No fixed sleeps: it
// re-checks only when onSettled fires (or immediately if the
// state is already terminal).
export async function waitForCheckAction(
  signals: SaveWaitSignals,
): Promise<CheckDecision> {
  while (true) {
    const d = decideCheckAction(signals.getState());
    if (d !== "wait") return d;
    await new Promise<void>((resolve) => {
      const unsub = signals.onSettled(() => {
        unsub();
        resolve();
      });
    });
  }
}
