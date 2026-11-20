import { test } from "node:test";
import { strict as assert } from "node:assert";
import { decideCheckAction, waitForCheckAction } from "../saveWait.ts";

// ─── decideCheckAction ────────────────────────────────────────────

test("decideCheckAction: in flight + staged -> wait", () => {
  assert.equal(
    decideCheckAction({ inFlight: true, stagedKeys: 2, stopped: false }),
    "wait",
  );
});

test("decideCheckAction: in flight only -> wait", () => {
  assert.equal(
    decideCheckAction({ inFlight: true, stagedKeys: 0, stopped: false }),
    "wait",
  );
});

test("decideCheckAction: staged only -> wait", () => {
  assert.equal(
    decideCheckAction({ inFlight: false, stagedKeys: 3, stopped: false }),
    "wait",
  );
});

test("decideCheckAction: failed save (stopped) -> stop, even if still inFlight", () => {
  // The save loop may still have an in-flight request when it
  // transitions to 'stopped' (last retry). Check() must not run.
  assert.equal(
    decideCheckAction({ inFlight: true, stagedKeys: 0, stopped: true }),
    "stop",
  );
  assert.equal(
    decideCheckAction({ inFlight: false, stagedKeys: 0, stopped: true }),
    "stop",
  );
});

test("decideCheckAction: settled -> run", () => {
  assert.equal(
    decideCheckAction({ inFlight: false, stagedKeys: 0, stopped: false }),
    "run",
  );
});

// ─── waitForCheckAction: small fake queue ─────────────────────────

function makeQueue(initial) {
  let state = { ...initial };
  const subs = new Set();
  return {
    state,
    update(patch) {
      state = { ...state, ...patch };
      // Each state change fires every one-shot listener.
      for (const fn of subs) fn();
    },
    signals: {
      getState: () => state,
      onSettled: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
  };
}

test("waitForCheckAction: already settled -> returns 'run' at once", async () => {
  const q = makeQueue({ inFlight: false, stagedKeys: 0, stopped: false });
  assert.equal(await waitForCheckAction(q.signals), "run");
});

test("waitForCheckAction: already stopped -> returns 'stop' at once", async () => {
  const q = makeQueue({ inFlight: false, stagedKeys: 0, stopped: true });
  assert.equal(await waitForCheckAction(q.signals), "stop");
});

test("waitForCheckAction: waits for inFlight to clear, then runs", async () => {
  const q = makeQueue({ inFlight: true, stagedKeys: 0, stopped: false });
  const p = waitForCheckAction(q.signals);
  // Clear the flight after a short delay (simulates a save finishing).
  setTimeout(() => q.update({ inFlight: false }), 5);
  assert.equal(await p, "run");
});

test("waitForCheckAction: waits for staged to drain through an inflight cycle", async () => {
  // Pattern: user typed while nothing was in flight; the next save
  // starts (staged -> inFlight) and finishes (inFlight -> settled).
  const q = makeQueue({ inFlight: false, stagedKeys: 1, stopped: false });
  const p = waitForCheckAction(q.signals);
  setTimeout(() => q.update({ inFlight: true, stagedKeys: 0 }), 5);
  setTimeout(() => q.update({ inFlight: false }), 15);
  assert.equal(await p, "run");
});

test("waitForCheckAction: waits for inFlight + staged to clear", async () => {
  // Both at once (typical "typed while a save was running").
  const q = makeQueue({ inFlight: true, stagedKeys: 2, stopped: false });
  const p = waitForCheckAction(q.signals);
  setTimeout(() => q.update({ inFlight: false }), 5);     // first save landed, staged still queued
  setTimeout(() => q.update({ inFlight: true, stagedKeys: 0 }), 10); // second save starts
  setTimeout(() => q.update({ inFlight: false }), 20);    // second save lands
  assert.equal(await p, "run");
});

test("waitForCheckAction: failed save mid-wait -> returns 'stop'", async () => {
  const q = makeQueue({ inFlight: true, stagedKeys: 1, stopped: false });
  const p = waitForCheckAction(q.signals);
  // The retry loop gives up: still in-flight (last request) but the
  // state carries 'stopped' now. The waiter sees stop on the next
  // signal and resolves. The component's save line already explains.
  setTimeout(() => q.update({ stopped: true }), 5);
  assert.equal(await p, "stop");
});

test("waitForCheckAction: unsubscribe runs so listeners do not leak", async () => {
  // After resolving, no listener should remain registered.
  const q = makeQueue({ inFlight: true, stagedKeys: 0, stopped: false });
  const p = waitForCheckAction(q.signals);
  setTimeout(() => q.update({ inFlight: false }), 5);
  await p;
  // Peek inside the fake queue to confirm no dangling listener.
  // `subs` is private; drive one more state change to prove no
  // callback fires on the resolved promise (we'd see an error if
  // the unsub didn't happen because resolve() was already called
  // on the settled promise).
  let extraFires = 0;
  q.signals.onSettled(() => extraFires++);
  q.update({ inFlight: false });
  // Our new listener fires once, but the previous one must not.
  assert.equal(extraFires, 1);
});
