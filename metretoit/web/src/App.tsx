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
import { MentionsPage, CguPage, PrivacyPage, LegalLinks } from "./pages/Legal";
import { ForgotPage, ResetPage } from "./pages/Password";
import { HelpPage } from "./pages/Help";
import {
  IFolderFill,
  IPlus,
  IPlusCircle,
  IFile,
  IBuilding,
  ICard,
  ISettings,
  IHelp,
  IChevronUp,
  IMenu,
  ILogout,
  IKey,
} from "./components/Icons";

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
        <Route path="/mot-de-passe-oublie" element={<ForgotPage />} />
        <Route path="/reinitialiser" element={<ResetPage />} />
        <Route path="/mentions-legales" element={<MentionsPage />} />
        <Route path="/cgu" element={<CguPage />} />
        <Route path="/confidentialite" element={<PrivacyPage />} />
        <Route path="/app/*" element={me?.user ? <AppShell /> : <Navigate to="/connexion" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Ctx.Provider>
  );
}

const PAGE_TITLES: [RegExp, string][] = [
  [/^\/app\/?$/, "Mes études"],
  [/^\/app\/nouvelle/, "Nouvelle étude"],
  [/^\/app\/etudes\//, "Étude"],
  [/^\/app\/rapports/, "Rapports"],
  [/^\/app\/entreprise/, "Entreprise"],
  [/^\/app\/abonnement/, "Abonnement"],
];

function AppShell() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  useEffect(() => {
    setDrawer(false);
    setUserMenu(false);
  }, [loc.pathname]);
  const fullBleed = /^\/app\/(etudes\/|nouvelle)/.test(loc.pathname);
  const title = PAGE_TITLES.find(([r]) => r.test(loc.pathname))?.[1] ?? "MétréToit";
  const initial = (me?.user?.name ?? "?").trim().charAt(0).toUpperCase();

  const sidebar = (
    <aside className={`sidebar ${drawer ? "open" : ""}`} aria-label="Menu principal">
      <div className="sb-brand">
        <Link to="/app" aria-label="Mes études">
          <Logo size={34} />
        </Link>
        {me?.org?.hasLogo && (
          <>
            <span className="sb-sep" />
            <img className="sb-client" src="/api/org/logo" alt={me.org.name} />
          </>
        )}
      </div>
      <Link to="/app/nouvelle" className="sb-new">
        <span>Nouvelle étude</span>
        <IPlusCircle size={20} />
      </Link>
      <nav className="sb-nav">
        <NavLink to="/app" end>
          <IFolderFill /> <span>Mes études</span>
        </NavLink>
        <NavLink to="/app/rapports">
          <IFile /> <span>Rapports</span>
        </NavLink>
        <NavLink to="/app/entreprise">
          <IBuilding /> <span>Entreprise</span>
        </NavLink>
        {me?.features?.billing && (
          <NavLink to="/app/abonnement">
            <ICard /> <span>Abonnement</span>
          </NavLink>
        )}
      </nav>
      <div className="sb-bottom">
        <div className="sb-icons">
          <Link to="/app/entreprise" title="Réglages" aria-label="Réglages">
            <ISettings />
          </Link>
          <span className="sb-vsep" />
          <a href="/aide" title="Aide" aria-label="Aide" onClick={(e) => { e.preventDefault(); nav("/app/aide"); }}>
            <IHelp />
          </a>
        </div>
        <div className="sb-user-wrap">
          {userMenu && (
            <div className="sb-user-menu" role="menu">
              <Link to="/app/entreprise#mot-de-passe" role="menuitem">
                <IKey /> Mon mot de passe
              </Link>
              <button
                role="menuitem"
                onClick={async () => {
                  await logout();
                  nav("/connexion");
                }}
              >
                <ILogout /> Déconnexion
              </button>
            </div>
          )}
          <button className="sb-user" onClick={() => setUserMenu(!userMenu)} aria-expanded={userMenu}>
            <span className="avatar">{initial}</span>
            <span className="sb-user-txt">
              <b>{me?.user?.name}</b>
              <small>{me?.user?.email}</small>
            </span>
            <IChevronUp size={16} className={userMenu ? "" : "rot180"} />
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <div className={`shell2 ${fullBleed ? "is-full" : ""}`}>
      {sidebar}
      {drawer && <div className="drawer-veil" onClick={() => setDrawer(false)} />}
      <header className="mobilebar">
        <button className="mb-burger" aria-label="Ouvrir le menu" onClick={() => setDrawer(true)}>
          <IMenu size={22} />
        </button>
        <div className="mb-title">
          <span className="title-ico small">
            <IFolderFill size={14} />
          </span>
          {title}
        </div>
        <Link to="/app/nouvelle" className="mb-plus" aria-label="Nouvelle étude">
          <IPlus size={22} />
        </Link>
      </header>
      <main className="content2">
        <Routes>
          <Route index element={<StudiesPage />} />
          <Route path="nouvelle" element={<NewStudyPage />} />
          <Route path="etudes/:id" element={<StudyPage />} />
          <Route path="rapports" element={<ReportsPage />} />
          <Route path="entreprise" element={<SettingsPage />} />
          <Route path="abonnement" element={<BillingPage />} />
          <Route path="aide" element={<HelpPage />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
        {!fullBleed && <LegalLinks />}
      </main>
    </div>
  );
}
