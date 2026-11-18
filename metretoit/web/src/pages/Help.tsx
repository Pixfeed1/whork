import { Link } from "react-router-dom";
import { EDGE_TYPES } from "../../../shared/roof";

export function HelpPage() {
  return (
    <div className="page narrow">
      <PageHead title="Aide" />
      <div className="card help">
        <h2>Faire un métré en 4 étapes</h2>
        <ol>
          <li>
            <b>Nouvelle étude</b> : tapez l'adresse, vérifiez que le bon bâtiment est surligné en orange (cliquez sur un
            bâtiment voisin pour l'ajouter), puis « Lancer le métrage automatique ».
          </li>
          <li>
            <b>Vérifiez</b> les pans sur la photo aérienne. Chaque arête porte sa longueur ; la liste des linéaires et des
            pans est à droite.
          </li>
          <li>
            <b>Corrigez si besoin</b> avec la barre d'outils : glisser un sommet, ajouter un sommet sur une arête, dessiner ou
            découper un pan, changer la pente d'un pan ou le type d'une arête. Ctrl+Z annule.
          </li>
          <li>
            <b>Générez le rapport PDF</b> : il reprend votre logo et vos coordonnées (menu Entreprise).
          </li>
        </ol>
      </div>
      <div className="card help">
        <h2>Types d'arêtes</h2>
        <ul className="help-edges">
          {EDGE_TYPES.map((e) => (
            <li key={e.type}>
              <span className="swatch" style={{ background: e.color }} /> <b>{e.label}</b> : {e.help.toLowerCase()}
            </li>
          ))}
        </ul>
      </div>
      <div className="card help">
        <h2>Précision</h2>
        <p>
          Les métrés sont calculés à partir du relevé laser LiDAR HD de l'IGN (0,5 m) et, si activé, de Google Solar API. Ils
          servent à préparer un devis : confirmez les cotes sur site avant de commander les matériaux. Les petites lucarnes,
          cheminées ou arbres au-dessus du toit peuvent demander une correction manuelle.
        </p>
        <p>
          Besoin d'un compte supplémentaire pour un collaborateur ? <Link to="/app/entreprise">Entreprise → Utilisateurs</Link>.
        </p>
      </div>
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="page-head2">
      <span className="title-ico">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </span>
      <h1>{title}</h1>
      <div className="grow" />
      {children}
    </div>
  );
}
