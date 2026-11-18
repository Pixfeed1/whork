// Logo MétréToit : emblème (toit + règle graduée dans un cercle) et nom sur deux lignes.
export function Emblem({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx="32" cy="32" r="28.5" stroke="currentColor" strokeWidth="4" />
      <path d="M15 35 32 19.5 49 35" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 45.5h28" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M18 40.5v5M25 43v2.5M32 41v4.5M39 43v2.5M46 40.5v5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ size = 40, light = false }: { size?: number; light?: boolean }) {
  return (
    <span className={`logo ${light ? "logo-light" : ""}`}>
      <Emblem size={size} />
      <span className="logo-word" style={{ fontSize: size * 0.42 }}>
        <span>MÉTRÉ</span>
        <span>TOIT</span>
      </span>
    </span>
  );
}
