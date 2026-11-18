import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate, Link } from "react-router-dom";
import { api, type Me } from "./api";
import { LandingPage } from "./pages/Landing";
import { LoginPage, RegisterPage } from "./pages/Auth";
import { StudiesPage } from "./pages/Studies";
import { NewStudyPage } from "./pages/NewStudy";
import { StudyPage } from "./pages/Study";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
import { BillingPage } from "./pages/Billing";
import { Logo } from "./components/Logo";

interface AuthCtx {
  me: Me | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>({ me: null, refresh: async () => {}, logout: async () => {} });
export const useAuth = () => useContext(Ctx);

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/auth/me"));
    } catch {
      setMe({ user: null });
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    setMe({ user: null });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (loading) return <div className="center-screen">Chargement…</div>;
  return (
    <Ctx.Provider value={{ me, refresh, logout }}>
      <Routes>
        <Route path="/" element={me?.user ? <Navigate to="/app" replace /> : <LandingPage />} />
        <Route path="/connexion" element={me?.user ? <Navigate to="/app" replace /> : <LoginPage />} />
        <Route path="/inscription" element={me?.user ? <Navigate to="/app/entreprise?bienvenue=1" replace /> : <RegisterPage />} />
        <Route path="/app/*" element={me?.user ? <AppShell /> : <Navigate to="/connexion" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Ctx.Provider>
  );
}

function AppShell() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [loc.pathname]);
  const fullBleed = /^\/app\/(etudes\/|nouvelle)/.test(loc.pathname);
  return (
    <div className={`shell ${fullBleed ? "shell-full" : ""}`}>
      <header className="topbar">
        <Link to="/app" className="brand" aria-label="MétréToit">
          <Logo size={34} />
        </Link>
        <button className="burger" aria-label="Menu" onClick={() => setMenu(!menu)}>
          ☰
        </button>
        <nav className={`mainnav ${menu ? "open" : ""}`}>
          <NavLink to="/app" end>
            Études
          </NavLink>
          <NavLink to="/app/rapports">Rapports</NavLink>
          <NavLink to="/app/entreprise">Entreprise</NavLink>
          {me?.features?.billing && <NavLink to="/app/abonnement">Abonnement</NavLink>}
          <span className="nav-user" title={me?.user?.email}>
            {me?.org?.name}
          </span>
          <button
            className="btn-link"
            onClick={async () => {
              await logout();
              nav("/connexion");
            }}
          >
            Déconnexion
          </button>
        </nav>
        <Link to="/app/nouvelle" className="btn btn-primary btn-new">
          + Nouvelle étude
        </Link>
      </header>
      <main className="content">
        <Routes>
          <Route index element={<StudiesPage />} />
          <Route path="nouvelle" element={<NewStudyPage />} />
          <Route path="etudes/:id" element={<StudyPage />} />
          <Route path="rapports" element={<ReportsPage />} />
          <Route path="entreprise" element={<SettingsPage />} />
          <Route path="abonnement" element={<BillingPage />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </main>
    </div>
  );
}
