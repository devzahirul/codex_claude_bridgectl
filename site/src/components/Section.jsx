export default function Section({ id, eyebrow, title, lead, children }) {
  return (
    <section id={id} className="section">
      <div className="container">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}
