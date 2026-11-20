// Photo satellite Google sous la carte de l'éditeur, via l'API Maps JavaScript (type « satellite »).
// C'est l'alternative que Google indique aux comptes européens, pour qui les tuiles satellite de la
// Map Tiles API sont refusées. La carte Google est placée sous la carte MapLibre (transparente) et suit
// exactement sa position : le zoom Google vaut le zoom MapLibre + 1 (tuiles de 256 px contre 512 px).
import type { Map as MlMap } from "maplibre-gl";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    google?: any;
    __mtGoogleReady?: () => void;
  }
}

let loading: Promise<any> | null = null;

/** charge le script Google Maps une seule fois */
export function loadGoogleMaps(key: string): Promise<any> {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.__mtGoogleReady = () => resolve(window.google.maps);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=fr&region=FR&loading=async&callback=__mtGoogleReady`;
    s.async = true;
    s.onerror = () => {
      loading = null;
      reject(new Error("Chargement de Google Maps impossible"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface GoogleUnderlay {
  /** zoom MapLibre maximal pour rester dans les photos disponibles */
  maxZoom: number;
  destroy: () => void;
}

/**
 * Crée la carte Google dans `host` (placé sous le conteneur MapLibre) et la synchronise.
 * Renvoie null si Google n'a pas pu être chargé (clé absente, refusée, réseau…).
 */
export async function attachGoogleUnderlay(
  map: MlMap,
  host: HTMLDivElement,
  key: string,
  onMaxZoom: (z: number) => void,
): Promise<GoogleUnderlay | null> {
  let gm: any;
  try {
    gm = await loadGoogleMaps(key);
  } catch {
    return null;
  }
  const c = map.getCenter();
  const g = new gm.Map(host, {
    center: { lat: c.lat, lng: c.lng },
    zoom: map.getZoom() + 1,
    mapTypeId: "satellite",
    tilt: 0,
    heading: 0,
    disableDefaultUI: true,
    gestureHandling: "none",
    keyboardShortcuts: false,
    clickableIcons: false,
    isFractionalZoomEnabled: true,
    backgroundColor: "#1f2937",
  });
  const sync = () => {
    const ce = map.getCenter();
    g.moveCamera({ center: { lat: ce.lat, lng: ce.lng }, zoom: map.getZoom() + 1, heading: 0, tilt: 0 });
  };
  map.on("move", sync);
  map.on("resize", sync);
  sync();

  // zoom maximal des photos Google à cet endroit (souvent 20 à 21) : au-delà, la photo ne suivrait plus
  let maxZoom = 20;
  try {
    const r = await new gm.MaxZoomService().getMaxZoomAtLatLng({ lat: c.lat, lng: c.lng });
    if (r?.status === "OK" && Number.isFinite(r.zoom)) maxZoom = r.zoom - 1;
  } catch {
    /* on garde la valeur par défaut */
  }
  onMaxZoom(maxZoom);

  return {
    maxZoom,
    destroy: () => {
      map.off("move", sync);
      map.off("resize", sync);
      host.innerHTML = "";
    },
  };
}
