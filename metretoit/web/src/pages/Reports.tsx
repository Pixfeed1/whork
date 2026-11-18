import { useEffect, useState } from "react";
import { PageHead } from "./Help";
import { Link } from "react-router-dom";
import { api, fmtDateTime, type Report } from "../api";

const nf = (n: number, d = 1) => n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

export function ReportsPage() {
  const [rows, setRows] = useState<Report[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Report[]>("/reports").then(setRows).catch((e) => setErr(e.message));
  }, []);
  return (
    <div className="page">
      <PageHead title="Historique des rapports" />
      {err && <div className="alert alert-error">{err}</div>}
      {rows === null ? (
        <p className="muted">Chargement…</p>
      ) : rows.length === 0 ? (
        <div className="empty card">
          <h2>Aucun rapport</h2>
          <p>Les rapports PDF générés depuis une étude apparaîtront ici.</p>
        </div>
      ) : (
        <ReportTable rows={rows} showAddress />
      )}
    </div>
  );
}

export function ReportTable({ rows, showAddress, onDelete }: { rows: Report[]; showAddress?: boolean; onDelete?: (id: string) => void }) {
  return (
    <div className="table-wrap card">
      <table className="table">
        <thead>
          <tr>
            <th>Réf.</th>
            {showAddress && <th>Adresse</th>}
            <th className="num">Surface</th>
            <th className="hide-sm">Établi le</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="strong">{r.number}</td>
              {showAddress && (
                <td>
                  <Link to={`/app/etudes/${r.studyId}`}>{r.address}</Link>
                </td>
              )}
              <td className="num">{nf(r.summary.area)} m²</td>
              <td className="hide-sm">
                {fmtDateTime(r.createdAt)}
                {r.author ? <span className="muted"> · {r.author}</span> : null}
              </td>
              <td className="actions">
                <a className="btn btn-sm" href={`/api/reports/${r.id}/pdf`} target="_blank" rel="noreferrer">
                  Ouvrir
                </a>
                <a className="btn btn-sm" href={`/api/reports/${r.id}/pdf?download=1`}>
                  Télécharger
                </a>
                {onDelete && (
                  <button className="btn btn-sm btn-danger-ghost" onClick={() => onDelete(r.id)}>
                    Supprimer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
