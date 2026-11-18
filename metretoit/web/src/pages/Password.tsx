import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../App";
import { Logo } from "../components/Logo";
import { LegalLinks } from "./Legal";

export function ForgotPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "nomail">("idle");
  const [err, setErr] = useState("");
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setState("busy");
          setErr("");
          try {
            const r = await api<{ mail: boolean }>("/auth/forgot", { body: { email } });
            setState(r.mail ? "sent" : "nomail");
          } catch (er: any) {
            setErr(er.message);
            setState("idle");
          }
        }}
      >
        <Link to="/" className="auth-logo">
          <Logo size={46} />
        </Link>
        <h1 className="caps">Mot de passe oublié</h1>
        {state === "sent" ? (
          <div className="alert alert-ok">
            Si un compte existe pour cette adresse, un e-mail vient d'être envoyé avec un lien pour choisir un nouveau mot de passe
            (valable 1 heure). Pensez à vérifier vos indésirables.
          </div>
        ) : state === "nomail" ? (
          <div className="alert alert-info">
            Demandez au responsable de votre compte de vous attribuer un nouveau mot de passe (menu Entreprise → Utilisateurs).
          </div>
        ) : (
          <>
            <p className="small muted center">Indiquez l'adresse e-mail de votre compte : vous recevrez un lien de réinitialisation.</p>
            <input type="email" required placeholder="Adresse e-mail" aria-label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} />
            {err && <div className="alert alert-error">{err}</div>}
            <button className="btn btn-primary btn-block btn-square" disabled={state === "busy"}>
              {state === "busy" ? "Envoi…" : "Recevoir le lien"}
            </button>
          </>
        )}
        <p className="muted small center">
          <Link to="/connexion">Retour à la connexion</Link>
        </p>
        <LegalLinks />
      </form>
    </div>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (p1 !== p2) return setErr("Les deux mots de passe ne correspondent pas");
          setBusy(true);
          setErr("");
          try {
            await api("/auth/reset", { body: { token: params.get("token") ?? "", password: p1 } });
            await refresh();
            nav("/app");
          } catch (er: any) {
            setErr(er.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Link to="/" className="auth-logo">
          <Logo size={46} />
        </Link>
        <h1 className="caps">Nouveau mot de passe</h1>
        <input type="password" required minLength={8} autoComplete="new-password" placeholder="Nouveau mot de passe (8 caractères minimum)" aria-label="Nouveau mot de passe" value={p1} onChange={(e) => setP1(e.target.value)} />
        <input type="password" required minLength={8} autoComplete="new-password" placeholder="Confirmer le mot de passe" aria-label="Confirmer le mot de passe" value={p2} onChange={(e) => setP2(e.target.value)} />
        {err && <div className="alert alert-error">{err}</div>}
        <button className="btn btn-primary btn-block btn-square" disabled={busy}>
          {busy ? "Enregistrement…" : "Enregistrer et me connecter"}
        </button>
        <p className="muted small center">
          <Link to="/mot-de-passe-oublie">Demander un nouveau lien</Link>
        </p>
      </form>
    </div>
  );
}
