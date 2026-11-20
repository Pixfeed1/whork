// Logo Relevéo : marque complète (« Relevéo.fr — On mesure. Vous chiffrez. ») et pastille « R » pour les espaces réduits.
export function Emblem({ size = 40, className }: { size?: number; className?: string }) {
  return <img className={`logo-mark ${className ?? ""}`} src="/favicon.svg" width={size} height={size} alt="" aria-hidden="true" />;
}

export function Logo({ size = 40, light = false }: { size?: number; light?: boolean }) {
  const h = Math.round(size * 1.35);
  return (
    <span className={`logo ${light ? "logo-light" : ""}`}>
      <Emblem size={size} className="logo-compact" />
      <img
        className="logo-word logo-img"
        src={light ? "/img/releveo-blanc.png" : "/img/releveo.png"}
        height={h}
        width={Math.round(h * 2.95)}
        alt="Relevéo.fr — On mesure. Vous chiffrez."
      />
    </span>
  );
}
