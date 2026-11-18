import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtDate, type Org } from "../api";
import { useAuth } from "../App";

/** Redimensionne une image en PNG (max 800 px) pour le logo des rapports. */
async function imageToPng(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const s = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function SettingsPage() {
  const { me, refresh } = useAuth();
  const [params] = useSearchParams();
  const owner = me?.user?.role === "owner";
  const [org, setOrg] = useState<Org | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [logoV, setLogoV] = useState(Date.now());
  useEffect(() => {
    api<Org>("/org").then(setOrg);
  }, []);
  if (!org) return <div className="page">Chargement…</div>;
  const set = (k: keyof Org) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setOrg({ ...org, [k]: e.target.value } as Org);
  const flash = (m: string) => {
    setMsg(m);
    setErr("");
    setTimeout(() => setMsg(""), 2500);
  };
  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Entreprise</h1>
      </div>
      {params.get("bienvenue") && (
        <div className="alert alert-info">
          Bienvenue ! Renseignez vos coordonnées et votre logo : ils apparaîtront sur chaque rapport PDF.
        </div>
      )}
      {msg && <div className="alert alert-ok">{msg}</div>}
      {err && <div className="alert alert-error">{err}</div>}
      <form
        className="card form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setOrg(await api<Org>("/org", { method: "PUT", body: org }));
            await refresh();
            flash("Coordonnées enregistrées");
          } catch (e: any) {
            setErr(e.message);
          }
        }}
      >
        <h2 className="span2">Coordonnées (en-tête des rapports)</h2>
        <label className="span2">
          Raison sociale
          <input value={org.name} onChange={set("name")} disabled={!owner} required />
        </label>
        <label className="span2">
          Adresse
          <input value={org.address} onChange={set("address")} disabled={!owner} />
        </label>
        <label>
          Code postal
          <input value={org.postcode} onChange={set("postcode")} disabled={!owner} />
        </label>
        <label>
          Ville
          <input value={org.city} onChange={set("city")} disabled={!owner} />
        </label>
        <label>
          Téléphone
          <input value={org.phone} onChange={set("phone")} disabled={!owner} />
        </label>
        <label>
          E-mail
          <input type="email" value={org.email} onChange={set("email")} disabled={!owner} />
        </label>
        <label>
          Site web
          <input value={org.website} onChange={set("website")} disabled={!owner} />
        </label>
        <label>
          SIRET
          <input value={org.siret} onChange={set("siret")} disabled={!owner} />
        </label>
        <label>
          Majoration pour chutes (%)
          <input type="number" min={0} max={50} step={1} value={org.wastePct} onChange={set("wastePct")} disabled={!owner} />
        </label>
        <label className="span2">
          Mention en pied de page des rapports
          <textarea
            rows={2}
            value={org.reportFooter}
            onChange={set("reportFooter")}
            disabled={!owner}
            placeholder="Métrage établi à distance à partir de relevés aériens. Les valeurs sont à confirmer sur site avant commande des matériaux."
          />
        </label>
        {owner && (
          <div className="span2">
            <button className="btn btn-primary">Enregistrer</button>
          </div>
        )}
      </form>

      <div className="card">
        <h2>Logo</h2>
        <div className="logo-row">
          {org.hasLogo ? (
            <img className="logo-preview" src={`/api/org/logo?v=${logoV}`} alt="Logo" />
          ) : (
            <div className="logo-preview empty-logo">Aucun logo</div>
          )}
          {owner && (
            <div className="stack">
              <label className="btn">
                Choisir une image…
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      await api("/org/logo", { method: "PUT", body: { dataUrl: await imageToPng(f) } });
                      setOrg({ ...org, hasLogo: true });
                      setLogoV(Date.now());
                      flash("Logo mis à jour");
                    } catch (er: any) {
                      setErr(er.message);
                    }
                  }}
                />
              </label>
              {org.hasLogo && (
                <button
                  className="btn btn-danger-ghost"
                  onClick={async () => {
                    await api("/org/logo", { method: "DELETE" });
                    setOrg({ ...org, hasLogo: false });
                  }}
                >
                  Retirer
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Members owner={owner} selfId={me?.user?.id ?? ""} />
      <PasswordCard />
    </div>
  );
}

function Members({ owner, selfId }: { owner: boolean; selfId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState({ name: "", email: "", password: "", role: "member" });
  const [err, setErr] = useState("");
  const load = () => api<any[]>("/org/members").then(setRows);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="card">
      <h2>Utilisateurs</h2>
      <table className="table">
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>
                <div className="strong">{u.name}</div>
                <div className="muted small">{u.email}</div>
              </td>
              <td>{u.role === "owner" ? "Responsable" : "Utilisateur"}</td>
              <td className="hide-sm">depuis le {fmtDate(u.createdAt)}</td>
              <td className="actions">
                {owner && u.id !== selfId && (
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      const pw = prompt(`Nouveau mot de passe pour ${u.name} (8 caractères minimum) :`);
                      if (!pw) return;
                      try {
                        await api(`/org/members/${u.id}/password`, { method: "PUT", body: { password: pw } });
                        alert(`Mot de passe de ${u.name} modifié. Communiquez-le-lui : il pourra le changer dans Entreprise → Mon mot de passe.`);
                      } catch (er: any) {
                        alert(er.message);
                      }
                    }}
                  >
                    Nouveau mot de passe
                  </button>
                )}
                {owner && u.id !== selfId && (
                  <button
                    className="btn btn-sm btn-danger-ghost"
                    onClick={async () => {
                      if (!confirm(`Supprimer l'accès de ${u.name} ?`)) return;
                      await api(`/org/members/${u.id}`, { method: "DELETE" });
                      load();
                    }}
                  >
                    Retirer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {owner && (
        <form
          className="form-grid add-member"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr("");
            try {
              await api("/org/members", { body: f });
              setF({ name: "", email: "", password: "", role: "member" });
              load();
            } catch (er: any) {
              setErr(er.message);
            }
          }}
        >
          <h3 className="span2">Ajouter un utilisateur</h3>
          <label>
            Nom
            <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label>
            E-mail
            <input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <label>
            Mot de passe provisoire
            <input required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </label>
          <label>
            Rôle
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="member">Utilisateur</option>
              <option value="owner">Responsable</option>
            </select>
          </label>
          {err && <div className="alert alert-error span2">{err}</div>}
          <div className="span2">
            <button className="btn">Ajouter</button>
          </div>
        </form>
      )}
    </div>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState("");
  return (
    <form
      className="card form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/auth/password", { method: "PUT", body: f });
          setF({ current: "", next: "" });
          setMsg("Mot de passe modifié");
        } catch (er: any) {
          setMsg(er.message);
        }
      }}
    >
      <h2 className="span2">Mon mot de passe</h2>
      <label>
        Actuel
        <input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
      </label>
      <label>
        Nouveau
        <input type="password" autoComplete="new-password" minLength={8} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
      </label>
      {msg && <div className="span2 muted">{msg}</div>}
      <div className="span2">
        <button className="btn">Modifier</button>
      </div>
    </form>
  );
}
