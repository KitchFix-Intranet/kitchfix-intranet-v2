"use client";

// For ai-new groups: the ingredient doesn't exist yet, so the normal
// rename / category / resale / merge forms have nothing to act on.
// This placeholder reads the AI's proposed name + parent and points
// Kevin at the "Create ingredient" button in the review card.
//
// Lifted verbatim from DetailPanel.tsx in N7 commit 0.

export function PendingIngredientBlock({
  proposedName,
  proposedParent,
}: {
  proposedName: string | null;
  proposedParent: string | null;
}) {
  return (
    <section className="kf-drawer__block kf-dpn__pending" aria-label="Ingredient not yet created">
      <header className="kf-drawer__block-head">
        <h4>Ingredient not yet created</h4>
        <small>finish the create flow to edit</small>
      </header>
      <p className="kf-dpn__pending-body">
        The matcher proposed <strong>{proposedName ?? "a new ingredient"}</strong>
        {proposedParent ? <> under <strong>{proposedParent}</strong></> : null}. Hit
        &ldquo;New ingredient&rdquo; on the card below to create it (category required). Rename,
        category, resale, and merge become available once it exists.
      </p>
    </section>
  );
}
