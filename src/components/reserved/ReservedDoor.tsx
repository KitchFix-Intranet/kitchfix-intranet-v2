import "./reserved.css";

// Reserved doors are landing pages for tools that aren't live in this shell
// yet. Keep the copy product-shaped: a sentence on what the door will be, a
// plain "Coming after Ingredients" note. No step numbers (the Ingredients
// tabs carry that detail where it matters), no table / schema names.

type Props = {
  name: string;
  one_line: string;
  arrives?: string;
};

export function ReservedDoor({ name, one_line, arrives }: Props) {
  return (
    <section className="kf-reserved">
      <header className="kf-reserved__header">
        <span className="kf-eyebrow">KitchFix</span>
        <h2>{name}</h2>
        <p className="kf-reserved__lede">{one_line}</p>
      </header>

      <article className="kf-reserved__card">
        <span className="kf-reserved__pill">{arrives ?? "Coming after Ingredients"}</span>
        <p className="kf-reserved__body">
          Until this door is live, {name} runs on the current intranet.
          The link in the rail is a placeholder so the shape of KitchFix
          stays visible from day one.
        </p>
      </article>
    </section>
  );
}
