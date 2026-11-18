import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo, Emblem } from "../components/Logo";
import { RegisterForm } from "./Auth";

export function LandingPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [menu, setMenu] = useState(false);
  return (
    <div className="landing">
      <section className="hero" style={{ backgroundImage: "url(/img/hero-re.jpg)" }}>
        <div className="hero-veil" />
        <header className="hero-nav">
          <Link to="/" aria-label="Accueil">
            <Logo size={46} light />
          </Link>
          <button className="burger light" aria-label="Menu" onClick={() => setMenu(!menu)}>
            ☰
          </button>
          <nav className={menu ? "open" : ""} onClick={() => setMenu(false)}>
            <a href="#top">Accueil</a>
            <a href="#metres">Métrés</a>
            <a href="#plateforme">Plateforme</a>
            <a href="#contact">Contact</a>
            <Link to="/connexion" className="btn btn-outline-light">
              Connexion
            </Link>
          </nav>
        </header>
        <div className="hero-body" id="top">
          <h1>Le métré de toiture automatique pour les couvreurs</h1>
          <p>Une adresse suffit : surfaces, pentes et linéaires calculés en quelques secondes, sans monter sur le toit.</p>
          <a href="#contact" className="btn btn-outline-light btn-lg">
            Essayer MétréToit
          </a>
        </div>
      </section>

      <section className="feature-row" id="metres">
        <div className="feature-text">
          <span className="pill-tag">MétréToit Rapports</span>
          <h2 className="caps">Rapports de métrage en quelques secondes</h2>
          <ul>
            <li>Surface, pente et orientation de chaque pan, en vraie grandeur.</li>
            <li>Faîtages, égouts, rives, noues et arêtiers mesurés automatiquement, majoration pour chutes incluse.</li>
            <li>Rapport PDF à votre logo : vue aérienne annotée, plans cotés et tableau récapitulatif.</li>
          </ul>
          <a href="#contact" className="btn btn-outline">
            Voir plus
          </a>
        </div>
        <div className="feature-card">
          <img src="/img/rapports.webp" alt="Pages d'un rapport de métrage MétréToit" loading="lazy" />
        </div>
      </section>

      <section className="feature-row reverse" id="plateforme">
        <div className="feature-text">
          <span className="pill-tag">MétréToit Plateforme</span>
          <h2 className="caps">Un outil complet, sur tous vos écrans</h2>
          <ul>
            <li>Détection automatique à partir du relevé 3D LiDAR HD de l'IGN et de Google Solar API.</li>
            <li>Correction en quelques clics : sommets, pans, pentes et types d'arêtes.</li>
            <li>Historique des études et des rapports partagé avec toute votre équipe, au bureau comme sur le chantier.</li>
          </ul>
          <a href="#contact" className="btn btn-outline">
            Voir plus
          </a>
        </div>
        <div className="feature-card">
          <img src="/img/plateforme.webp" alt="L'éditeur MétréToit sur ordinateur et smartphone" loading="lazy" />
        </div>
      </section>

      <section className="band">
        <h2 className="accent-title">Testez sur vos propres toitures</h2>
        <p>Créez votre compte et lancez votre premier métré en moins d'une minute.</p>
        <form
          className="band-form"
          onSubmit={(e) => {
            e.preventDefault();
            nav(`/inscription?email=${encodeURIComponent(email)}`);
          }}
        >
          <input type="email" placeholder="Votre adresse e-mail" aria-label="Votre adresse e-mail" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn btn-outline">Commencer</button>
        </form>
      </section>

      <section className="contact" id="contact">
        <div className="contact-text">
          <h2 className="caps big">
            Prêt à gagner du temps
            <br />
            sur vos devis ?
            <br />
            <strong>Lancez-vous.</strong>
          </h2>
          <p>MétréToit n'est pas qu'un logiciel : c'est un outil pensé avec des couvreurs, pour des couvreurs.</p>
          <p>Créez votre compte : vos premières études sont prêtes en quelques secondes.</p>
        </div>
        <div className="contact-form">
          <h3 className="accent-title">Créer un compte</h3>
          <RegisterForm />
        </div>
      </section>

      <footer className="site-foot">
        <div className="foot-brand">
          <Emblem size={42} className="accent-color" />
          <span className="small muted">metre.pixfeed.net</span>
        </div>
        <div>
          <h4>Produit</h4>
          <a href="#metres">Métrés</a>
          <a href="#plateforme">Plateforme</a>
          <Link to="/connexion">Connexion</Link>
        </div>
        <div>
          <h4>Ressources</h4>
          <a href="https://geoservices.ign.fr/lidarhd" target="_blank" rel="noreferrer">
            LiDAR HD de l'IGN
          </a>
          <a href="https://developers.google.com/maps/documentation/solar" target="_blank" rel="noreferrer">
            Google Solar API
          </a>
          <a href="#contact">Créer un compte</a>
        </div>
        <p className="foot-copy tiny muted">© {new Date().getFullYear()} MétréToit · Données aériennes © IGN Géoplateforme</p>
      </footer>
    </div>
  );
}
