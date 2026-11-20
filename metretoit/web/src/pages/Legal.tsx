// Pages légales : mentions légales, CGU, politique de confidentialité.
// Les informations de la société viennent du fichier .env (LEGAL_*) ; les champs
// non renseignés apparaissent surlignés « à compléter ».
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Logo } from "../components/Logo";

type LegalInfo = Record<
  "company" | "form" | "capital" | "address" | "siret" | "rcs" | "vat" | "director" | "email" | "phone" | "host" | "updated",
  string
>;

function useLegal() {
  const [l, setL] = useState<LegalInfo | null>(null);
  useEffect(() => {
    api<{ legal: LegalInfo }>("/public/config")
      .then((r) => setL(r.legal))
      .catch(() => setL({} as LegalInfo));
  }, []);
  return l;
}

const V = ({ v, label }: { v?: string; label: string }) => (v && v.trim() ? <>{v}</> : <mark className="todo">[{label} à compléter]</mark>);

function LegalLayout({ title, children, updated }: { title: string; children: ReactNode; updated?: string }) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return (
    <div className="legal-page">
      <header className="legal-head">
        <Link to="/" aria-label="Accueil">
          <Logo size={38} />
        </Link>
        <Link to="/connexion" className="btn btn-outline btn-sm">
          Connexion
        </Link>
      </header>
      <article className="legal-body">
        <h1 className="caps">{title}</h1>
        {updated && <p className="muted small">Dernière mise à jour : {updated}</p>}
        {children}
      </article>
      <LegalLinks />
    </div>
  );
}

export function LegalLinks() {
  return (
    <nav className="legal-links tiny">
      <Link to="/mentions-legales">Mentions légales</Link>
      <Link to="/cgu">Conditions d'utilisation</Link>
      <Link to="/confidentialite">Confidentialité</Link>
    </nav>
  );
}

export function MentionsPage() {
  const l = useLegal();
  if (!l) return null;
  return (
    <LegalLayout title="Mentions légales" updated={l.updated}>
      <h2>Éditeur du service</h2>
      <p>
        Le service Relevéo est édité par <V v={l.company} label="raison sociale" />, <V v={l.form} label="forme juridique" />
        {l.capital ? <> au capital de {l.capital}</> : null}, dont le siège est situé <V v={l.address} label="adresse du siège" />.
      </p>
      <p>
        SIRET : <V v={l.siret} label="SIRET" />
        {" · "}RCS : <V v={l.rcs} label="ville et numéro RCS" />
        {" · "}TVA intracommunautaire : <V v={l.vat} label="numéro de TVA" />
      </p>
      <p>
        Directeur de la publication : <V v={l.director} label="nom du dirigeant" />
      </p>
      <p>
        Contact : <V v={l.email} label="e-mail" />
        {l.phone ? <> · {l.phone}</> : null}
      </p>
      <h2>Hébergement</h2>
      <p>
        <V v={l.host} label="nom, adresse et téléphone de l'hébergeur" />
      </p>
      <h2>Propriété intellectuelle</h2>
      <p>
        L'application, son code, son logo, sa charte graphique et ses textes sont la propriété de l'éditeur. Toute reproduction
        sans autorisation est interdite. Les rapports produits par les utilisateurs leur appartiennent.
      </p>
      <h2>Données géographiques</h2>
      <p>
        Orthophotographies, bâtiments, adresses et relevés LiDAR HD : © IGN – Géoplateforme, réutilisés sous Licence Ouverte
        Etalab 2.0. Le cas échéant, données Google Maps Platform (Solar API) © Google, utilisées conformément à leurs
        conditions d'utilisation.
      </p>
    </LegalLayout>
  );
}

export function CguPage() {
  const l = useLegal();
  if (!l) return null;
  return (
    <LegalLayout title="Conditions générales d'utilisation" updated={l.updated}>
      <h2>1. Objet</h2>
      <p>
        Les présentes conditions encadrent l'utilisation du service en ligne Relevéo (le « Service »), édité par{" "}
        <V v={l.company} label="raison sociale" />, qui permet d'estimer à distance les métrés d'une toiture (surfaces, pentes,
        linéaires) et d'éditer des rapports. La création d'un compte vaut acceptation des présentes conditions.
      </p>
      <h2>2. Compte et accès</h2>
      <p>
        Le Service est réservé aux professionnels. L'utilisateur fournit des informations exactes et garde ses identifiants
        confidentiels. Le responsable d'un compte entreprise gère les accès de ses collaborateurs et reste responsable de leur
        utilisation du Service.
      </p>
      <h2>3. Nature des métrés</h2>
      <p>
        Les métrés sont calculés automatiquement à partir de relevés aériens (LiDAR, orthophotographies, données Google) dont la
        date et la précision varient. Ils constituent une <strong>estimation</strong> destinée à préparer un devis. Il appartient
        à l'utilisateur de les vérifier, et de les confirmer sur site avant toute commande de matériaux ou tout engagement
        contractuel. L'éditeur ne garantit pas l'exactitude des mesures et ne peut être tenu responsable d'un écart entre les
        valeurs estimées et les dimensions réelles.
      </p>
      <h2>4. Abonnement et paiement</h2>
      <p>
        Le cas échéant, l'accès au Service au-delà de la période d'essai est soumis à un abonnement dont le prix est indiqué
        avant la souscription. L'abonnement est payable d'avance, renouvelé automatiquement chaque période et résiliable à tout
        moment depuis l'espace « Abonnement », avec effet à la fin de la période en cours. Le paiement est traité par le
        prestataire Stripe.
      </p>
      <h2>5. Données de l'utilisateur</h2>
      <p>
        Les études, rapports, logos et informations saisies restent la propriété de l'utilisateur. L'éditeur s'interdit de les
        utiliser à d'autres fins que la fourniture du Service. L'utilisateur peut supprimer ses études et demander la suppression
        de son compte à tout moment.
      </p>
      <h2>6. Disponibilité</h2>
      <p>
        L'éditeur s'efforce d'assurer l'accès au Service en continu, sans obligation de résultat. Le Service dépend de sources de
        données tierces (IGN, Google) dont l'indisponibilité peut limiter certaines fonctions.
      </p>
      <h2>7. Responsabilité</h2>
      <p>
        La responsabilité de l'éditeur est limitée aux dommages directs et prévisibles, et plafonnée au montant payé par
        l'utilisateur au titre des douze derniers mois.
      </p>
      <h2>8. Données personnelles</h2>
      <p>
        Le traitement des données personnelles est décrit dans la <Link to="/confidentialite">politique de confidentialité</Link>.
      </p>
      <h2>9. Modification et droit applicable</h2>
      <p>
        L'éditeur peut faire évoluer les présentes conditions ; l'utilisateur en est informé et peut résilier son compte. Les
        présentes conditions sont soumises au droit français. À défaut d'accord amiable, les tribunaux du ressort du siège de
        l'éditeur sont compétents.
      </p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  const l = useLegal();
  if (!l) return null;
  return (
    <LegalLayout title="Politique de confidentialité" updated={l.updated}>
      <h2>Responsable du traitement</h2>
      <p>
        <V v={l.company} label="raison sociale" />, <V v={l.address} label="adresse du siège" />. Contact :{" "}
        <V v={l.email} label="e-mail" />.
      </p>
      <h2>Données traitées</h2>
      <ul>
        <li>Compte : nom, adresse e-mail, mot de passe (stocké chiffré, jamais lisible).</li>
        <li>Entreprise : raison sociale, coordonnées, SIRET, logo.</li>
        <li>Études : adresses des bâtiments, nom du client et observations saisis par l'utilisateur, métrés et rapports.</li>
        <li>Technique : un cookie de session, indispensable à la connexion. Aucun cookie publicitaire ni de mesure d'audience.</li>
      </ul>
      <h2>Finalités et bases légales</h2>
      <ul>
        <li>Fournir le Service et gérer les comptes (exécution du contrat).</li>
        <li>Sécuriser le Service, prévenir les abus (intérêt légitime).</li>
        <li>Facturation des abonnements (obligation légale).</li>
      </ul>
      <h2>Destinataires et sous-traitants</h2>
      <ul>
        <li>
          Hébergement : <V v={l.host} label="hébergeur" />.
        </li>
        <li>IGN – Géoplateforme : recherche d'adresses et données géographiques (les adresses recherchées lui sont transmises).</li>
        <li>Google (Solar API), si activé : coordonnées du bâtiment analysé.</li>
        <li>Stripe, en cas d'abonnement : données de paiement (l'éditeur n'a jamais accès aux numéros de carte).</li>
        <li>Prestataire d'envoi d'e-mails : adresse e-mail, pour la réinitialisation du mot de passe.</li>
      </ul>
      <p>Les données ne sont ni vendues ni utilisées à des fins publicitaires.</p>
      <h2>Durées de conservation</h2>
      <p>
        Les données du compte et des études sont conservées tant que le compte est actif, puis supprimées dans un délai de 3 mois
        après sa fermeture. Les pièces comptables sont conservées 10 ans.
      </p>
      <h2>Vos droits</h2>
      <p>
        Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité de vos
        données, en écrivant à <V v={l.email} label="e-mail" />. Vous pouvez également introduire une réclamation auprès de la
        CNIL (www.cnil.fr).
      </p>
      <h2>Sécurité</h2>
      <p>
        Connexion chiffrée (HTTPS), mots de passe chiffrés, cloisonnement strict des données entre entreprises, accès limité au
        personnel habilité.
      </p>
    </LegalLayout>
  );
}
