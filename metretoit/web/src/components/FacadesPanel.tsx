import { useState } from "react";
import type { RoofModel } from "../../../shared/roof";
import {
  computeFacades,
  setFacadeOverride,
  setFacadesConfig,
  OPENING_TYPES,
  type Opening,
  type OpeningType,
  type FacadesResult,
} from "../../../shared/facades";
import { newId } from "../../../shared/roof";

const nf = (n: number, d = 1) => n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

export function FacadesPanel({
  model,
  studyId,
  onChange,
  onHover,
}: {
  model: RoofModel;
  studyId: string;
  onChange: (m: RoofModel) => void;
  onHover: (key: string | null) => void;
}) {
  const cfg = model.facades;
  if (!cfg?.enabled) {
    return (
      <div className="card soft">
        <h3 style={{ marginTop: 0 }}>Métré des façades</h3>
        <p className="small">
          Surface de chaque façade (pignons compris), murs mitoyens exclus, ouvertures déduites, photos Street View, et une page
          dédiée dans le rapport PDF.
        </p>
        <button className="btn btn-primary" onClick={() => onChange(setFacadesConfig(model, { enabled: true }))}>
          Activer le métré des façades
        </button>
      </div>
    );
  }
  const r: FacadesResult = computeFacades(model);
  const t = r.totals;
  return (
    <div className="facades">
      <div className="tiles">
        <div className="tile">
          <span>Surface brute</span>
          <b data-testid="facades-gross">{nf(t.gross)} m²</b>
        </div>
        <div className="tile">
          <span>Surface nette (à peindre)</span>
          <b>{nf(t.net)} m²</b>
        </div>
        <div className="tile">
          <span>Ouvertures déduites</span>
          <b>{nf(t.openings)} m²</b>
        </div>
        <div className="tile">
          <span>Façades · linéaire</span>
          <b>
            {t.count} · {nf(t.length)} m
          </b>
        </div>
      </div>
      <p className="small muted">
        Murs : {r.source === "emprise" ? "emprise du bâtiment (IGN), recalée sur le relevé 3D" : "contour de la toiture (débord compris)"}.
        Hauteurs : {r.heightSource === "relevé" ? "mesurées sur le relevé 3D" : "hauteur d'égout par défaut, à ajuster"}.
      </p>
      <label className="row gap small" style={{ flexDirection: "row", alignItems: "center" }}>
        Déduction par défaut des ouvertures
        <input
          type="number"
          min={0}
          max={90}
          step={1}
          style={{ width: 80 }}
          value={cfg.defaultDeductPct ?? 0}
          onChange={(e) => onChange(setFacadesConfig(model, { defaultDeductPct: Math.max(0, Math.min(90, Number(e.target.value) || 0)) }))}
        />
        %
      </label>
      {r.facades.length === 0 && (
        <div className="alert alert-warn">
          Aucune façade à calculer : le contour du bâtiment n'est pas connu. Relancez la détection ou dessinez la toiture.
        </div>
      )}
      {r.facades.map((f) => {
        const ov = cfg.overrides?.[f.key] ?? {};
        const openings = ov.openings ?? [];
        const setOpenings = (ops: Opening[]) => onChange(setFacadeOverride(model, f.key, { openings: ops }));
        return (
          <div
            key={f.key}
            className={`card facade-card ${f.excluded ? "excluded" : ""}`}
            onMouseEnter={() => onHover(f.key)}
            onMouseLeave={() => onHover(null)}
          >
            <div className="row between">
              <h4>
                <span className="fac-tag">F{f.index}</span> {f.label}
              </h4>
              <label className="switch small">
                <input type="checkbox" checked={!f.excluded} onChange={(e) => onChange(setFacadeOverride(model, f.key, { excluded: !e.target.checked }))} />
                {f.excluded ? (f.mitoyenAuto ? "Mitoyenne (exclue)" : "Exclue") : "Incluse"}
              </label>
            </div>
            <div className="fac-grid small">
              <span>Longueur</span>
              <b>{nf(f.length, 2)} m</b>
              <span>Hauteur à l'égout</span>
              <span>
                <input
                  type="number"
                  min={0.5}
                  max={40}
                  step={0.1}
                  className="mini"
                  value={ov.eaveHeight ?? Number(f.eaveHeight.toFixed(2))}
                  onChange={(e) => onChange(setFacadeOverride(model, f.key, { eaveHeight: Number(e.target.value) || null }))}
                />{" "}
                m
              </span>
              <span>Surface brute</span>
              <b>
                {nf(f.grossArea)} m²{f.gableArea > 0.3 ? <span className="muted"> (dont pignon {nf(f.gableArea)})</span> : null}
              </b>
              <span>Ouvertures</span>
              <b>
                {nf(f.openingsArea)} m²{openings.length ? ` (${f.openingsCount})` : f.deductPct ? ` (${f.deductPct} %)` : ""}
              </b>
              <span>Surface nette</span>
              <b className="accent-color">{nf(f.netArea)} m²</b>
            </div>
            {!f.excluded && (
              <>
                <StreetView studyId={studyId} fkey={f.key} sig={`${f.mid[0].toFixed(5)}${f.azimuth}`} />
                <div className="openings">
                  {openings.map((o, i) => (
                    <div className="op-row" key={o.id}>
                      <select
                        value={o.type}
                        onChange={(e) => {
                          const d = OPENING_TYPES.find((x) => x.type === e.target.value)!;
                          setOpenings(openings.map((x, j) => (j === i ? { ...x, type: d.type as OpeningType, width: d.width, height: d.height } : x)));
                        }}
                        aria-label="Type d'ouverture"
                      >
                        {OPENING_TYPES.map((x) => (
                          <option key={x.type} value={x.type}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                      <input type="number" min={0} step={1} value={o.count} aria-label="Nombre" title="Nombre" onChange={(e) => setOpenings(openings.map((x, j) => (j === i ? { ...x, count: Math.max(0, Math.round(Number(e.target.value) || 0)) } : x)))} />
                      <span>×</span>
                      <input type="number" min={0.1} step={0.05} value={o.width} aria-label="Largeur (m)" title="Largeur (m)" onChange={(e) => setOpenings(openings.map((x, j) => (j === i ? { ...x, width: Number(e.target.value) || 0.1 } : x)))} />
                      <span>×</span>
                      <input type="number" min={0.1} step={0.05} value={o.height} aria-label="Hauteur (m)" title="Hauteur (m)" onChange={(e) => setOpenings(openings.map((x, j) => (j === i ? { ...x, height: Number(e.target.value) || 0.1 } : x)))} />
                      <button className="icon-btn danger" aria-label="Retirer l'ouverture" onClick={() => setOpenings(openings.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="row gap wrap">
                    <button className="btn btn-sm" onClick={() => setOpenings([...openings, { id: newId("op"), type: "fenetre", count: 1, width: 1.0, height: 1.25 }])}>
                      + Ajouter une ouverture
                    </button>
                    {!openings.length && (
                      <label className="row gap small" style={{ flexDirection: "row", alignItems: "center", margin: 0 }}>
                        ou déduire
                        <input
                          type="number"
                          min={0}
                          max={90}
                          className="mini"
                          placeholder={String(cfg.defaultDeductPct ?? 0)}
                          value={ov.deductPct ?? ""}
                          onChange={(e) => onChange(setFacadeOverride(model, f.key, { deductPct: e.target.value === "" ? null : Number(e.target.value) }))}
                        />
                        %
                      </label>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
      <button className="btn btn-sm btn-ghost" onClick={() => onChange(setFacadesConfig(model, { enabled: false }))}>
        Désactiver le métré des façades
      </button>
    </div>
  );
}

function StreetView({ studyId, fkey, sig }: { studyId: string; fkey: string; sig: string }) {
  const [state, setState] = useState<"load" | "ok" | "none">("load");
  const [big, setBig] = useState(false);
  const src = `/api/studies/${studyId}/facades/${fkey}/streetview.jpg?s=${encodeURIComponent(sig)}`;
  return (
    <div className="sv">
      {state !== "none" ? (
        <img
          src={src}
          alt="Vue Street View de la façade"
          loading="lazy"
          className={big ? "big" : ""}
          onLoad={() => setState("ok")}
          onError={() => setState("none")}
          onClick={() => setBig(!big)}
          style={{ display: state === "ok" ? "block" : "none" }}
        />
      ) : null}
      {state === "load" && <div className="sv-ph small muted">Recherche d'une vue Street View…</div>}
      {state === "none" && <div className="sv-ph small muted">Pas de vue Street View pour cette façade (cachée depuis la rue, ou service non activé).</div>}
    </div>
  );
}
