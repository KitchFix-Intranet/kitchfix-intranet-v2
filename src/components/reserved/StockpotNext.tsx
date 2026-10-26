// Lightweight placeholder for Stockpot sub-pages (Recipes / Menus / Signs)
// that are not yet live. The topbar already carries the page name + crumb;
// this surface explains what the page will become.
import "./reserved.css";

export function StockpotNext({ one_line, arrives }: { one_line: string; arrives: string }) {
  return (
    <section className="kf-reserved kf-reveal" style={{ ["--i" as never]: 1 }}>
      <article className="kf-card kf-reserved__card">
        <header>
          <span className="kf-pill kf-pill--info">{arrives}</span>
        </header>
        <p className="kf-reserved__body">{one_line}</p>
      </article>
    </section>
  );
}
