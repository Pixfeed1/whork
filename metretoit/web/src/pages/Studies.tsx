import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as maplibregl from "maplibre-gl";
import "../components/maplibreSetup";
import { api, type Study } from "../api";
import { useAuth } from "../App";
import { baseStyle } from "../components/mapStyle";
import { PageHead } from "./Help";
import { IList, IGrid, IMap, IUser, IChevronRight, IHome, ISearch } from "../components/Icons";

type View = "liste" | "vignettes" | "carte";
const nf = (n: number, d = 1) => n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

/** « 12 Rue X 17410 Saint-Martin-de-Ré » → adresse courte + « 17410 Saint-Martin-de-Ré » */
export function splitAddress(a: string): { street: string; city: string } {
  const m = /^(.*?)[,\s]+(\d{5})\s+(.+)$/.exec(a.trim());
  if (m) return { street: m[1].replace(/,\s*$/, ""), city: `${m[2]} ${m[3]}` };
  const parts = a.split(",");
  return parts.length > 1 ? { street: parts[0].trim(), city: parts.slice(1).join(",").trim() } : { street: a, city: "" };
}

export function fmtLong(s: string) {
  const d = new Date(s);
  return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })} à ${d
    .toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    .replace(":", "h")}`;
}

function readView(): View {
  try {
    const v = localStorage.getItem("mt_vue");
    if (v === "liste" || v === "vignettes" || v === "carte") return v;
  } catch {
    /* stockage indisponible */
  }
  return "vignettes";
}

export function StudiesPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Study[] | null>(null);
  const [err, setErr] = useState("");
  const [view, setView] = useState<View>(readView);
  useEffect(() => {
    try {
      localStorage.setItem("mt_vue", view);
    } catch {
      /* ignoré */
    }
  }, [view]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<Study[]>(`/studies${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then(setRows)
        .catch((e) => setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const quota = me?.quota;
  const views: [View, string, React.ReactNode][] = [
    ["liste", "Liste", <IList size={16} />],
    ["vignettes", "Vignettes", <IGrid size={16} />],
    ["carte", "Carte", <IMap size={16} />],
  ];
  return (
    <div className="page wide">
      <PageHead title="Mes études">
        <div className="view-toggle" role="group" aria-label="Affichage">
          {views.map(([k, label, icon]) => (
            <button key={k} className={view === k ? "active" : ""} onClick={() => setView(k)} aria-pressed={view === k} title={label}>
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </div>
      </PageHead>
      <div className="search-bar">
        <ISearch size={18} />
        <input placeholder="Rechercher une adresse, un client…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher" />
      </div>
      {quota?.enforced && (
        <div className={`alert ${quota.allowed ? "alert-info" : "alert-warn"}`}>
          {quota.plan === "trial"
            ? `Essai gratuit : ${quota.used} / ${quota.limit} études utilisées.`
            : quota.limit
              ? `Ce mois-ci : ${quota.used} / ${quota.limit} études.`
              : `Abonnement actif.`}{" "}
          {!quota.allowed && <Link to="/app/abonnement">S'abonner</Link>}
        </div>
      )}
      {err && <div className="alert alert-error">{err}</div>}
      {rows === null ? (
        <p className="muted">Chargement…</p>
      ) : rows.length === 0 ? (
        <div className="empty card">
          <h2>{q ? "Aucun résultat" : "Aucune étude pour l'instant"}</h2>
          {!q && (
            <>
              <p>Lancez votre premier métré : saisissez simplement l'adresse du bâtiment.</p>
              <Link to="/app/nouvelle" className="btn btn-primary">
                Nouvelle étude
              </Link>
            </>
          )}
        </div>
      ) : view === "vignettes" ? (
        <div className="card-grid">
          {rows.map((s) => (
            <StudyCard key={s.id} s={s} />
          ))}
        </div>
      ) : view === "liste" ? (
        <div className="table-wrap card">
          <table className="table">
            <thead>
              <tr>
                <th>Adresse</th>
                <th className="hide-sm">Client</th>
                <th className="num">Surface</th>
                <th className="num hide-sm">Pans</th>
                <th className="hide-sm">Statut</th>
                <th className="hide-sm">Modifiée le</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const a = splitAddress(s.address);
                return (
                  <tr key={s.id} className="clickable" onClick={() => nav(`/app/etudes/${s.id}`)}>
                    <td>
                      <div className="strong">{s.title || a.street}</div>
                      <div className="muted small">{a.city}</div>
                    </td>
                    <td className="hide-sm">{s.clientName || <span className="muted">Non renseigné</span>}</td>
                    <td className="num">{nf(s.totalArea)} m²</td>
                    <td className="num hide-sm">{s.faceCount}</td>
                    <td className="hide-sm">
                      <StatusBadge s={s} />
                    </td>
                    <td className="hide-sm">{fmtLong(s.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <StudiesMap rows={rows} />
      )}
    </div>
  );
}

function StatusBadge({ s, floating }: { s: Study; floating?: boolean }) {
  const ready = s.faceCount > 0;
  return <span className={`badge ${ready ? "badge-ok" : "badge-todo"} ${floating ? "badge-float" : ""}`}>{ready ? "Prêt" : "À dessiner"}</span>;
}

function StudyCard({ s }: { s: Study }) {
  const a = splitAddress(s.address);
  const [imgOk, setImgOk] = useState(true);
  return (
    <Link to={`/app/etudes/${s.id}`} className="study-card">
      <div className="sc-img">
        {imgOk ? (
          <img src={`/api/studies/${s.id}/vignette.svg?v=${encodeURIComponent(s.updatedAt)}`} alt="" loading="lazy" onError={() => setImgOk(false)} />
        ) : (
          <div className="sc-noimg" />
        )}
        <StatusBadge s={s} floating />
        <span className="badge badge-type">
          <IHome size={12} /> Toiture
        </span>
      </div>
      <div className="sc-body">
        <div className="sc-title">{s.title || a.street}</div>
        <div className="sc-city">{s.title ? s.address : a.city}</div>
        <div className={`sc-contact ${s.clientName ? "" : "is-none"}`}>
          <IUser size={14} /> {s.clientName || "Non renseigné"}
        </div>
        <div className="sc-meta">
          <span>{nf(s.totalArea)} m²</span>
          <span>·</span>
          <span>
            {s.faceCount} pan{s.faceCount > 1 ? "s" : ""}
          </span>
          {(s.reportCount ?? 0) > 0 && (
            <>
              <span>·</span>
              <span>
                {s.reportCount} rapport{(s.reportCount ?? 0) > 1 ? "s" : ""}
              </span>
            </>
          )}
        </div>
        <div className="sc-foot">
          <span className="sc-date">{fmtLong(s.updatedAt)}</span>
          <span className="sc-view">
            Voir <IChevronRight size={14} />
          </span>
        </div>
      </div>
    </Link>
  );
}

function StudiesMap({ rows }: { rows: Study[] }) {
  const el = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    const m = new maplibregl.Map({ container: el.current!, style: baseStyle(), center: [rows[0].lon, rows[0].lat], zoom: 12, maxZoom: 20 });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const b = new maplibregl.LngLatBounds([rows[0].lon, rows[0].lat], [rows[0].lon, rows[0].lat]);
    const markers = rows.map((s) => {
      b.extend([s.lon, s.lat]);
      const a = splitAddress(s.address);
      const div = document.createElement("button");
      div.className = "map-pin";
      div.title = s.address;
      div.innerHTML = `<span>${nf(s.totalArea, 0)} m²</span>`;
      div.onclick = () => nav(`/app/etudes/${s.id}`);
      void a;
      return new maplibregl.Marker({ element: div, anchor: "bottom" }).setLngLat([s.lon, s.lat]).addTo(m);
    });
    if (rows.length > 1) m.fitBounds(b, { padding: 70, maxZoom: 17, duration: 0 });
    else m.jumpTo({ center: [rows[0].lon, rows[0].lat], zoom: 17 });
    return () => {
      markers.forEach((mk) => mk.remove());
      m.remove();
    };
  }, [rows]);
  return <div ref={el} className="studies-map card" data-testid="studies-map" />;
}
