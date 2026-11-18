import { useEffect, useState } from "react";
import { PageHead } from "./Help";
import { useSearchParams } from "react-router-dom";
import { api, type Quota } from "../api";
import { useAuth } from "../App";

export function BillingPage() {
  const { me, refresh } = useAuth();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<{ enabled: boolean; quota: Quota; price: string | null } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api("/billing").then(setInfo);
    if (params.get("ok")) refresh();
  }, []);
  if (!info) return <div className="page">Chargement…</div>;
  const owner = me?.user?.role === "owner";
  const go = async (path: string) => {
    try {
      const { url } = await api<{ url: string }>(path, { method: "POST" });
      window.location.href = url;
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="page narrow">
      <PageHead title="Abonnement" />
      {params.get("ok") && <div className="alert alert-ok">Merci ! Votre abonnement est en cours d'activation.</div>}
      {err && <div className="alert alert-error">{err}</div>}
      {!info.enabled ? (
        <div className="card">
          <p>Les abonnements ne sont pas activés sur cette installation : utilisation illimitée.</p>
        </div>
      ) : (
        <div className="card">
          <h2>{info.quota.plan === "pro" ? "Abonnement Pro actif" : "Essai gratuit"}</h2>
          <p>
            {info.quota.plan === "trial"
              ? `${info.quota.used} / ${info.quota.limit} études utilisées pendant l'essai.`
              : info.quota.limit
                ? `${info.quota.used} / ${info.quota.limit} études ce mois-ci.`
                : "Études illimitées."}
          </p>
          {info.price && <p className="muted">Tarif : {info.price}</p>}
          {owner ? (
            info.quota.plan === "pro" ? (
              <button className="btn" onClick={() => go("/billing/portal")}>
                Gérer mon abonnement (factures, carte, résiliation)
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => go("/billing/checkout")}>
                S'abonner
              </button>
            )
          ) : (
            <p className="muted">Seul le responsable du compte peut gérer l'abonnement.</p>
          )}
        </div>
      )}
    </div>
  );
}
