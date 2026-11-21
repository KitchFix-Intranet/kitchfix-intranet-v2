// T6 round 3 + 4 item 1 proof. Static-source assertions on the item
// panel's component tree + per-editor state.
//
// R3 moved PanelAttention + PanelItemZone under a `key={item.id}`
// wrapper. R4 moved EVERYTHING else below the head (PanelStrip, the
// AwayBar, PanelIngredientZone / Pending, PanelClosedRows) into an
// ItemPanelBody sub-component mounted with that same `key={item.id}`.
// The three cross-cutting slots that used to live in DetailPanel
// (packHint, measureOpen, costedPerFocusNonce) moved into
// ItemPanelBody so the same remount discards them.
//
// R4 also removed the happy-dom dependency that the earlier Part A
// used to demonstrate React's key-remount behaviour. React's own
// semantics need no proof: this script now only asserts that the
// shape of the tree in DetailPanel + the state of each item-scoped
// editor match the fix. Chat-Claude drives the real components in
// a browser before the merge.
//
// Run: node --import tsx scripts/t6_item_scope_proof.mjs

import { readFileSync } from "node:fs";

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

const detailPanel = readFileSync(
  new URL("../src/components/ingredients/DetailPanel.tsx", import.meta.url),
  "utf8",
);
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
const measuresBlock = readFileSync(
  new URL("../src/components/ingredients/panel/PanelMeasuresBlock.tsx", import.meta.url),
  "utf8",
);

// Find the byte range that holds DetailPanel's body (above
// ItemPanelBody). Anything item-scoped inside that slice is OUTSIDE
// the identity and would survive a step.
const detailPanelStart = detailPanel.indexOf("export function DetailPanel(");
const itemBodyStart = detailPanel.indexOf("function ItemPanelBody(");
if (detailPanelStart < 0 || itemBodyStart < 0 || itemBodyStart < detailPanelStart) {
  console.log("FAIL: could not locate DetailPanel / ItemPanelBody functions");
  process.exit(1);
}
const detailBodySlice = detailPanel.slice(detailPanelStart, itemBodyStart);
const ipbSlice = detailPanel.slice(itemBodyStart);

// ---------------------------------------------------------------
// B1: DetailPanel mounts ItemPanelBody with a key on item.id.
// ---------------------------------------------------------------
ok(
  "B1: DetailPanel mounts <ItemPanelBody key={item.id} />",
  /<ItemPanelBody\b[\s\S]{0,400}?key=\{item\.id\}/.test(detailBodySlice),
  true,
);

// ---------------------------------------------------------------
// B2: Every item-scoped block renders INSIDE ItemPanelBody.
// ---------------------------------------------------------------
const insideBody = [
  "<AwayBar",
  "<PanelStrip",
  "<PanelAttention",
  "<PanelItemZone",
  "<PanelIngredientZone",
  "<PanelIngredientZonePending",
  "<PanelClosedRows",
];
for (const tag of insideBody) {
  ok(`B2: ${tag.slice(1)} renders inside ItemPanelBody`, ipbSlice.includes(tag), true);
}

// ---------------------------------------------------------------
// B3: Attention-to-zone bridge state lives INSIDE ItemPanelBody
// (so the remount discards it), NOT in DetailPanel's body.
// ---------------------------------------------------------------
ok("B3: packHint lives in ItemPanelBody", ipbSlice.includes("setPackHint"), true);
ok("B3: measureOpen lives in ItemPanelBody", ipbSlice.includes("setMeasureOpen"), true);
ok("B3: costedPerFocusNonce lives in ItemPanelBody", ipbSlice.includes("setCostedPerFocusNonce"), true);
ok("B3: DetailPanel no longer owns packHint", !detailBodySlice.includes("setPackHint"), true);
ok("B3: DetailPanel no longer owns measureOpen", !detailBodySlice.includes("setMeasureOpen"), true);
ok("B3: DetailPanel no longer owns costedPerFocusNonce", !detailBodySlice.includes("setCostedPerFocusNonce"), true);

// ---------------------------------------------------------------
// B4: The R3 reset-by-hand useEffect for packHint / measureOpen /
// costedPerFocusNonce is gone - the identity does the work.
// ---------------------------------------------------------------
ok(
  "B4: R3 reset effect removed (setPackHint not called from an effect in DetailPanel)",
  !/useEffect\([\s\S]{0,400}?setPackHint\(/.test(detailBodySlice),
  true,
);

// ---------------------------------------------------------------
// B5: Each pack / price / case-weight editor holds its own state;
// a remount discards every field in one shot. Same checks as R3.
// ---------------------------------------------------------------
ok("B5: PackOverrideBlock holds qtyStr via useState", /useState\<string\>\(initialQtyStr\)/.test(packBlock), true);
ok("B5: PackOverrideBlock holds partialPackSaved via useState", /useState\(false\)/.test(packBlock) && packBlock.includes("partialPackSaved"), true);
ok("B5: PriceOverrideBlock holds perBaseStr via useState", /useState\<string\>\(initialPerBaseStr\)/.test(priceBlock), true);
ok("B5: CaseWeightBlock holds val via useState", /\[val, setVal\] = useState/.test(caseBlock), true);

// ---------------------------------------------------------------
// B6: Partial-save retry reads "Save price".
// ---------------------------------------------------------------
ok(
  "B6: partial-save retry label is 'Save price'",
  /partialPackSaved && caseFieldChanged[\s\S]{0,80}\? "Save price"/.test(packBlock),
  true,
);

// ---------------------------------------------------------------
// B7: Keep editing returns focus to lastFieldRef in every editor,
// including the measure editor added in R4.
// ---------------------------------------------------------------
ok("B7: PackOverrideBlock has lastFieldRef", packBlock.includes("lastFieldRef"), true);
ok("B7: PriceOverrideBlock has lastFieldRef", priceBlock.includes("lastFieldRef"), true);
ok("B7: CaseWeightBlock has lastFieldRef", caseBlock.includes("lastFieldRef"), true);
ok("B7: PanelMeasuresBlock has lastFieldRef", measuresBlock.includes("lastFieldRef"), true);

// ---------------------------------------------------------------
// B8: Autofocus lands on the first TEXT input in each editor.
// ---------------------------------------------------------------
ok("B8: PackOverrideBlock autofocus is firstTextFieldRef", packBlock.includes("firstTextFieldRef"), true);
ok("B8: PanelMeasuresBlock autofocus is firstTextFieldRef", measuresBlock.includes("firstTextFieldRef"), true);

// ---------------------------------------------------------------
// B9: PanelMeasuresBlock registers add-row typed work with the
// panel's dirty registry (R4 fix; without this, Prev / Next did
// not ask when "2.5" sat in the add row). Its Esc handler raises
// the local ask when typed. The dirty-registry discard runs
// discardChanges so the add row closes too.
// ---------------------------------------------------------------
ok(
  "B9: PanelMeasuresBlock has addRowDirty flag",
  measuresBlock.includes("addRowDirty"),
  true,
);
ok(
  "B9: PanelMeasuresBlock dirty includes addRowDirty",
  /const dirty = !sameList\(draft, baseline\) \|\| addRowDirty;/.test(measuresBlock),
  true,
);
ok(
  "B9: PanelMeasuresBlock useDirtyEditor discard calls discardChanges",
  /useDirtyEditor\(`measures-\$\{ingredient\.id\}`[\s\S]{0,200}?discardChanges\(\)/.test(measuresBlock),
  true,
);
ok(
  "B9: PanelMeasuresBlock discardChanges closes the add row",
  /function discardChanges\(\) \{[\s\S]{0,200}?cancelAdd\(\)/.test(measuresBlock),
  true,
);
ok(
  "B9: PanelMeasuresBlock has an Esc handler on the add row",
  /onKeyDown=\{\(e\) => \{[\s\S]{0,200}?e\.key === "Escape"[\s\S]{0,200}?tryCloseAdd\(\)/.test(measuresBlock),
  true,
);
ok(
  "B9: PanelMeasuresBlock has a local Discard ask",
  measuresBlock.includes("editorAskOpen") && measuresBlock.includes("kf-ipanel__editor-ask"),
  true,
);

// ---------------------------------------------------------------
// B10: Panel-level Keep editing returns focus to the field the
// person was in (R4 small 1). captureAskLastFocus runs on every
// path that opens the ask; Keep editing refocuses via a micro-
// task so the ask has unmounted its own buttons first.
// ---------------------------------------------------------------
ok(
  "B10: DetailPanel captures last-focus before opening the ask",
  detailPanel.includes("panelAskLastFocusRef") && detailPanel.includes("captureAskLastFocus"),
  true,
);
// The refocus call lives inside the setTimeout inside the Keep
// editing button's onClick. Pin-point check: find the setTimeout
// -> panelAskLastFocusRef.current?.focus call AND assert it is in
// the panel-ask block (near the "kf-dpn__discard-ask-actions"
// marker where that button is rendered).
const askActionsIdx = detailPanel.indexOf("kf-dpn__discard-ask-actions");
const refocusIdx = detailPanel.indexOf(
  "panelAskLastFocusRef.current?.focus",
);
ok(
  "B10: panel Keep editing refocuses panelAskLastFocusRef",
  askActionsIdx > 0 &&
    refocusIdx > askActionsIdx &&
    refocusIdx - askActionsIdx < 1200,
  true,
);

console.log("");
console.log(`T6 item-scope proof: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
