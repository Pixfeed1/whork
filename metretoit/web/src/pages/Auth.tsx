import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../App";

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
        className="card auth-card"
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
        <Link to="/" className="brand brand-lg">
          <img src="/favicon.svg" alt="" width={36} height={36} /> MétréToit
        </Link>
        <h1>Connexion</h1>
        <label>
          E-mail
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mot de passe
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="alert alert-error">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Connexion…" : "Se connecter"}
        </button>
        <p className="muted small">
          Pas encore de compte ? <Link to="/inscription">Créer un compte</Link>
        </p>
      </form>
    </div>
  );
}

export function RegisterPage() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ orgName: "", name: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="auth-page">
      <form
        className="card auth-card"
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
        <Link to="/" className="brand brand-lg">
          <img src="/favicon.svg" alt="" width={36} height={36} /> MétréToit
        </Link>
        <h1>Créer un compte</h1>
        <label>
          Entreprise
          <input required value={f.orgName} onChange={set("orgName")} placeholder="Ex. : Couverture Martin" />
        </label>
        <label>
          Votre nom
          <input required autoComplete="name" value={f.name} onChange={set("name")} />
        </label>
        <label>
          E-mail
          <input type="email" required autoComplete="email" value={f.email} onChange={set("email")} />
        </label>
        <label>
          Mot de passe (8 caractères minimum)
          <input type="password" required minLength={8} autoComplete="new-password" value={f.password} onChange={set("password")} />
        </label>
        {err && <div className="alert alert-error">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Création…" : "Créer mon compte"}
        </button>
        <p className="muted small">
          Déjà inscrit ? <Link to="/connexion">Se connecter</Link>
        </p>
      </form>
    </div>
  );
}
