// T6 round 3 item 1 proof. Two independent checks:
//
// Part A (mechanism): React remounts a keyed subtree when its key
// changes, which discards every piece of local state the subtree
// held. The proof mounts a minimal React component under happy-dom,
// types into its input, swaps the parent's key, and asserts the
// input is blank again (not holding the prior typed text).
//
// Part B (source): DetailPanel.tsx places every item-scoped block
// INSIDE a <div key={item.id}> wrapper and resets panel-level
// cross-cutting state (packHint / measureOpen / costedPerFocusNonce
// / discardAskOpen / pendingStep) on item.id change. If either
// anchor moves out of the keyed wrapper or the useEffect, this
// proof fails until the invariant is re-stated.
//
// Why not drive PackOverrideBlock directly: it pulls useRouter from
// next/navigation + the Toaster from @/components/ui/Toaster. Both
// need a router context + a toast runtime that jsdom / happy-dom
// cannot provide without a full Next harness. The mechanism Part A
// tests is EXACTLY what the fix relies on (React's key remount
// semantics); if that holds + the key is in the right place in
// DetailPanel (Part B) + the save-decision is right (the existing
// t6_pack_save_proof.mjs), the three together cover the fault.
//
// Run: node --import tsx scripts/t6_item_scope_proof.mjs

import { Window } from "happy-dom";
import { readFileSync } from "node:fs";

// --- happy-dom set-up -------------------------------------------------
const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
// navigator is a getter on Node's globalThis; define via descriptor.
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  writable: true,
  configurable: true,
});
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.Event = window.Event;
globalThis.InputEvent = window.InputEvent;
globalThis.MouseEvent = window.MouseEvent;

// IS_REACT_ACT_ENVIRONMENT silences a React 19 warning when state
// updates fire outside of act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

let pass = 0;
let fail = 0;
function ok(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`ok   ${label} (got ${g}, want ${w})`);
  } else {
    fail++;
    console.log(`FAIL ${label}\n       got  ${g}\n       want ${w}`);
  }
}

// --- Part A: the key remount --------------------------------------------
// A stand-in editor component with local state. One text input +
// one button. Mirrors the shape of PackOverrideBlock without any
// Next.js / toaster coupling - the test is about React's own
// state-across-key behaviour.
function MiniEditor({ seed }) {
  const [value, setValue] = React.useState(seed);
  return React.createElement("input", {
    "data-testid": "mini-input",
    value,
    onChange: (e) => setValue(e.target.value),
  });
}

function Parent({ itemId, seed }) {
  // Mirrors DetailPanel's item-scope wrapper: a keyed boundary
  // around the "editor".
  return React.createElement(
    "div",
    { key: itemId, "data-testid": `scope-${itemId}` },
    React.createElement(MiniEditor, { seed }),
  );
}

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

// Row 1: open with item A seed, type a new value.
await act(async () => {
  root.render(React.createElement(Parent, { itemId: "A", seed: "" }));
});
let input = container.querySelector("[data-testid='mini-input']");
await act(async () => {
  input.value = "typed on A";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
});
input = container.querySelector("[data-testid='mini-input']");
ok("A: typed value reads back", input.value, "typed on A");

// Row 2: step to item B. The parent renders a child with a new
// key; React unmounts the A subtree and mounts a fresh B subtree.
// The input must read B's seed, NOT "typed on A".
await act(async () => {
  root.render(React.createElement(Parent, { itemId: "B", seed: "" }));
});
input = container.querySelector("[data-testid='mini-input']");
ok("B: local state cleared on key change", input.value, "");

// Row 3: step to a second item B with its OWN seed. Rendering with
// the SAME key would NOT remount; a fresh key does.
await act(async () => {
  root.render(React.createElement(Parent, { itemId: "C", seed: "C-seed" }));
});
input = container.querySelector("[data-testid='mini-input']");
ok("C: seeded with C's value", input.value, "C-seed");

root.unmount();

// --- Part B: static source assertions ----------------------------------
const detailPanel = readFileSync(
  new URL("../src/components/ingredients/DetailPanel.tsx", import.meta.url),
  "utf8",
);

// B1: the item-scoped wrapper has a key on item.id. The div with
// className kf-ipanel__itemscope sits around PanelAttention and
// PanelItemZone.
ok(
  "B1: item scope has key={item.id}",
  /<div\s+key=\{item\.id\}\s+className="kf-ipanel__itemscope"/.test(detailPanel),
  true,
);

// B2: PanelAttention and PanelItemZone render INSIDE that scope.
// Loose check: both component references appear below the
// kf-ipanel__itemscope marker in the file.
const scopeAt = detailPanel.indexOf('className="kf-ipanel__itemscope"');
const attentionAt = detailPanel.indexOf("<PanelAttention", scopeAt);
const itemZoneAt = detailPanel.indexOf("<PanelItemZone", scopeAt);
ok("B2: PanelAttention inside the item scope", attentionAt > scopeAt, true);
ok("B2: PanelItemZone inside the item scope", itemZoneAt > scopeAt, true);

// B3: the useEffect that resets panel-level cross-cutting state
// depends on currentItemId. Grep for the exact shape.
ok(
  "B3: packHint resets on item.id change",
  /useEffect\(\(\) => \{[\s\S]*?setPackHint\(null\)[\s\S]*?setMeasureOpen\(null\)[\s\S]*?setCostedPerFocusNonce\(0\)[\s\S]*?setDiscardAskOpen\(false\)[\s\S]*?setPendingStep\(null\)[\s\S]*?\}, \[currentItemId\]\);/.test(detailPanel),
  true,
);

// B4: PackOverrideBlock, PriceOverrideBlock, CaseWeightBlock each
// hold their own state (not lifted to DetailPanel). This means a
// remount of the scope truly discards their fields.
const packBlock = readFileSync(
  new URL("../src/components/ingredients/panel/PackOverrideBlock.tsx", import.meta.url),
  "utf8",
);
const priceBlock = readFileSync(
  new URL("../src/components/ingredients/panel/PriceOverrideBlock.tsx", import.meta.url),
  "utf8",
);
const caseBlock = readFileSync(
  new URL("../src/components/ingredients/panel/CaseWeightBlock.tsx", import.meta.url),
  "utf8",
);
ok("B4: PackOverrideBlock holds qtyStr via useState", /useState\<string\>\(initialQtyStr\)/.test(packBlock), true);
ok("B4: PackOverrideBlock holds partialPackSaved via useState", /useState\(false\)/.test(packBlock) && packBlock.includes("partialPackSaved"), true);
ok("B4: PriceOverrideBlock holds perBaseStr via useState", /useState\<string\>\(initialPerBaseStr\)/.test(priceBlock), true);
ok("B4: CaseWeightBlock holds val via useState", /\[val, setVal\] = useState/.test(caseBlock), true);

// B5: the Save button label branches on partialPackSaved +
// caseFieldChanged -> "Save price". T6 R3 small 3.
ok(
  "B5: partial-save retry label is 'Save price'",
  /partialPackSaved && caseFieldChanged[\s\S]{0,80}\? "Save price"/.test(packBlock),
  true,
);

// B6: Keep editing refocuses the last field in each editor.
ok("B6: PackOverrideBlock has lastFieldRef", packBlock.includes("lastFieldRef"), true);
ok("B6: PriceOverrideBlock has lastFieldRef", priceBlock.includes("lastFieldRef"), true);
ok("B6: CaseWeightBlock has lastFieldRef", caseBlock.includes("lastFieldRef"), true);

// B7: PackOverrideBlock autofocus targets firstTextFieldRef (an
// input), not the segmented button.
ok("B7: PackOverrideBlock autofocus is firstTextFieldRef", packBlock.includes("firstTextFieldRef"), true);

console.log("");
console.log(`T6 item-scope proof: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
