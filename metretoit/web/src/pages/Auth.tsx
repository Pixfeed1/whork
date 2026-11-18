import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../App";
import { Logo } from "../components/Logo";

export function LoginPage() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          try {
            await api("/auth/login", { body: { email, password } });
            await refresh();
            nav("/app");
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Link to="/" className="auth-logo">
          <Logo size={46} />
        </Link>
        <h1 className="caps">Connexion</h1>
        <input type="email" autoComplete="email" required placeholder="Adresse e-mail" aria-label="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          type="password"
          autoComplete="current-password"
          required
          placeholder="Mot de passe"
          aria-label="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && <div className="alert alert-error">{err}</div>}
        <button className="btn btn-primary btn-block btn-square" disabled={busy}>
          {busy ? "Connexion…" : "Se connecter"}
        </button>
        <p className="muted small center">
          Pas encore de compte ? <Link to="/inscription">Créer un compte</Link>
        </p>
      </form>
    </div>
  );
}

/** Formulaire d'inscription, réutilisé sur la page d'accueil. */
export function RegisterForm({ initialEmail = "" }: { initialEmail?: string }) {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ orgName: "", name: "", email: initialEmail, password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="register-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
          await api("/auth/register", { body: f });
          await refresh();
          nav("/app/entreprise?bienvenue=1");
        } catch (e: any) {
          setErr(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input required placeholder="Nom de l'entreprise" aria-label="Entreprise" value={f.orgName} onChange={set("orgName")} />
      <input required autoComplete="name" placeholder="Votre nom" aria-label="Votre nom" value={f.name} onChange={set("name")} />
      <input type="email" required autoComplete="email" placeholder="Adresse e-mail" aria-label="E-mail" value={f.email} onChange={set("email")} />
      <input
        type="password"
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="Mot de passe (8 caractères minimum)"
        aria-label="Mot de passe"
        value={f.password}
        onChange={set("password")}
      />
      {err && <div className="alert alert-error">{err}</div>}
      <button className="btn btn-primary btn-block btn-square" disabled={busy}>
        {busy ? "Création…" : "Créer mon compte"}
      </button>
      <p className="tiny muted center">
        Vos données restent les vôtres. Relevés aériens : IGN (Licence Ouverte Etalab).
      </p>
    </form>
  );
}

export function RegisterPage() {
  const [params] = useSearchParams();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="auth-logo">
          <Logo size={46} />
        </Link>
        <h1 className="caps">Créer un compte</h1>
        <RegisterForm initialEmail={params.get("email") ?? ""} />
        <p className="muted small center">
          Déjà inscrit ? <Link to="/connexion">Se connecter</Link>
        </p>
      </div>
    </div>
  );
}
