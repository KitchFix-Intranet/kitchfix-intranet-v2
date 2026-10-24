import "./reserved.css";

type Props = {
  name: string;
  one_line: string;
  reserved_bullets: string[];
  plug_in_bullets: string[];
};

export function ReservedDoor({ name, one_line, reserved_bullets, plug_in_bullets }: Props) {
  return (
    <>
      <header className="kf-reserved__header">
        <span className="kf-eyebrow">Reserved door</span>
        <h2>{name}</h2>
        <p className="kf-reserved__lede">{one_line}</p>
      </header>

      <div className="kf-reserved__grid">
        <article className="kf-card">
          <header>
            <span className="kf-eyebrow">What is reserved</span>
            <h3>Shape of the door</h3>
          </header>
          <ul className="kf-reserved__list">
            {reserved_bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </article>

        <article className="kf-card">
          <header>
            <span className="kf-eyebrow">The plug-in contract</span>
            <h3>How it joins the shell</h3>
          </header>
          <ul className="kf-reserved__list">
            {plug_in_bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </article>
      </div>
    </>
  );
}
