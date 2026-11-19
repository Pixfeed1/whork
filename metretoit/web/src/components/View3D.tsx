import { useMemo, useState } from "react";
import type { RoofModel } from "../../../shared/roof";
import { roofView, fitPolys } from "../../../shared/view3d";

const NAMES: Record<number, string> = { 0: "nord", 45: "nord-est", 90: "est", 135: "sud-est", 180: "sud", 225: "sud-ouest", 270: "ouest", 315: "nord-ouest" };

/** Aperçu 3D orientable de la toiture (SVG). */
export function View3D({ model }: { model: RoofModel }) {
  const [bearing, setBearing] = useState(225);
  const W = 360;
  const H = 230;
  const polys = useMemo(() => fitPolys(roofView(model, bearing), { x: 0, y: 0, w: W, h: H }, 12), [model, bearing]);
  if (!model.faces.length) return null;
  const turn = (d: number) => setBearing((b) => (((b + d) % 360) + 360) % 360);
  return (
    <div className="view3d">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Vue 3D depuis le ${NAMES[bearing]}`}>
        {polys.map((p, i) => (
          <polygon
            key={i}
            points={p.pts.map((q) => q.join(",")).join(" ")}
            fill={p.fill}
            stroke={p.stroke}
            strokeWidth={p.kind === "face" ? 0.8 : 0.5}
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <div className="view3d-ctrl">
        <button className="btn btn-sm" onClick={() => turn(-45)} aria-label="Tourner à gauche">
          ↺
        </button>
        <span className="small">Vue depuis le {NAMES[bearing]}</span>
        <button className="btn btn-sm" onClick={() => turn(45)} aria-label="Tourner à droite">
          ↻
        </button>
      </div>
    </div>
  );
}
