import { Link } from "react-router-dom";

export function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-top">
        <span className="brand">
          <img src="/favicon.svg" alt="" width={30} height={30} /> MétréToit
        </span>
        <span className="grow" />
        <Link to="/connexion" className="btn btn-ghost">
          Connexion
        </Link>
        <Link to="/inscription" className="btn btn-primary">
          Essayer
        </Link>
      </header>
      <section className="hero">
        <h1>Le métré de toiture, sans monter sur le toit.</h1>
        <p>
          Saisissez une adresse : MétréToit détecte les pans de la toiture à partir du relevé 3D aérien (LiDAR HD de l'IGN,
          Google Solar API) et calcule surfaces, pentes, faîtages, égouts, rives, noues et arêtiers. Vous corrigez si besoin,
          puis vous éditez un rapport PDF à votre en-tête.
        </p>
        <div className="hero-cta">
          <Link to="/inscription" className="btn btn-primary btn-lg">
            Créer un compte
          </Link>
          <Link to="/connexion" className="btn btn-ghost btn-lg">
            J'ai déjà un compte
          </Link>
        </div>
      </section>
      <section className="features">
        {[
          ["1. Adresse", "Recherche par adresse ou clic sur la carte, sélection du bâtiment."],
          ["2. Détection automatique", "Pans, pentes et arêtes calculés en quelques secondes à partir du relevé 3D."],
          ["3. Correction", "Déplacez un sommet, dessinez ou découpez un pan, changez le type d'une arête."],
          ["4. Rapport PDF", "Vue aérienne annotée, plans cotés, tableau des métrés, votre logo."],
        ].map(([t, d]) => (
          <div className="card feature" key={t}>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>
      <footer className="landing-foot muted small">Données : IGN Géoplateforme (Licence Ouverte Etalab) · Google Maps Platform</footer>
    </div>
  );
}
