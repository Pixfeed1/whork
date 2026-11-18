import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDate, type Study } from "../api";
import { useAuth } from "../App";

const nf = (n: number, d = 1) => n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

export function StudiesPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Study[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      api<Study[]>(`/studies${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then(setRows)
        .catch((e) => setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const quota = me?.quota;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Études</h1>
        <input className="search" placeholder="Rechercher une adresse, un client…" value={q} onChange={(e) => setQ(e.target.value)} />
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
                + Nouvelle étude
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap card">
          <table className="table">
            <thead>
              <tr>
                <th>Adresse</th>
                <th className="hide-sm">Client</th>
                <th className="num">Surface</th>
                <th className="num hide-sm">Pans</th>
                <th className="num hide-sm">Rapports</th>
                <th className="hide-sm">Modifiée le</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => nav(`/app/etudes/${s.id}`)}>
                  <td>
                    <div className="strong">{s.title || s.address}</div>
                    {s.title && <div className="muted small">{s.address}</div>}
                    {s.edited && <span className="tag">corrigée</span>}
                  </td>
                  <td className="hide-sm">{s.clientName}</td>
                  <td className="num">{nf(s.totalArea)} m²</td>
                  <td className="num hide-sm">{s.faceCount}</td>
                  <td className="num hide-sm">{s.reportCount ?? 0}</td>
                  <td className="hide-sm">{fmtDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
