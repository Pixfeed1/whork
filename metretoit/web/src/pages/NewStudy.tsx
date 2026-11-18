import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as maplibregl from "maplibre-gl";
import "../components/maplibreSetup";
import { api, type GeoResult, type Study } from "../api";
import { baseStyle } from "../components/mapStyle";
import { AddressSearch } from "../components/AddressSearch";
import { useAuth } from "../App";

type Sel = { id: string; point: [number, number] };

function pointInRing(p: [number, number], ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function NewStudyPage() {
  const nav = useNavigate();
  const { me, refresh } = useAuth();
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const [addr, setAddr] = useState<{ label: string; lon: number; lat: number } | null>(null);
  const [buildings, setBuildings] = useState<any>(null);
  const [sel, setSel] = useState<Sel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [source, setSource] = useState<"auto" | "ign" | "google">("auto");
  const [clientName, setClientName] = useState("");

  useEffect(() => {
    const m = new maplibregl.Map({
      container: mapEl.current!,
      style: baseStyle(),
      center: [-1.3655, 46.2028], // Saint-Martin-de-Ré
      zoom: 13,
      maxZoom: 21.5,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
    m.on("load", () => {
      m.addSource("bld", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "bld-fill", type: "fill", source: "bld", paint: { "fill-color": ["case", ["boolean", ["get", "sel"], false], "#f59e0b", "#ffffff"], "fill-opacity": ["case", ["boolean", ["get", "sel"], false], 0.35, 0.08] } });
      m.addLayer({ id: "bld-line", type: "line", source: "bld", paint: { "line-color": ["case", ["boolean", ["get", "sel"], false], "#f59e0b", "#ffffff"], "line-width": ["case", ["boolean", ["get", "sel"], false], 3, 1] } });
    });
    map.current = m;
    return () => m.remove();
  }, []);

  // affichage des bâtiments + sélection
  useEffect(() => {
    const m = map.current;
    if (!m || !buildings) return;
    const apply = () => {
      const src = m.getSource("bld") as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        ...buildings,
        features: buildings.features.map((f: any) => ({ ...f, properties: { ...f.properties, sel: sel.some((s) => s.id === f.properties.id) } })),
      });
    };
    if (m.isStyleLoaded()) apply();
    else m.once("load", apply);
  }, [buildings, sel]);

  // clic sur la carte : sélection / désélection d'un bâtiment
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const onClick = async (e: maplibregl.MapMouseEvent) => {
      const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      let fc = buildings;
      if (!addr) {
        // pas encore d'adresse : on part du point cliqué
        const r = await api<{ label: string | null }>(`/reverse?lon=${p[0]}&lat=${p[1]}`).catch(() => ({ label: null }));
        setAddr({ label: r.label ?? `${p[1].toFixed(6)}, ${p[0].toFixed(6)}`, lon: p[0], lat: p[1] });
        fc = await loadBuildings(p);
        setSel([]);
      }
      const hit = fc?.features.find((f: any) => pointInRing(p, f.geometry.coordinates[0]));
      if (!hit) return;
      setSel((s) => (s.some((x) => x.id === hit.properties.id) ? s.filter((x) => x.id !== hit.properties.id) : [...s, { id: hit.properties.id, point: p }]));
    };
    m.on("click", onClick);
    return () => {
      m.off("click", onClick);
    };
  }, [buildings, addr]);

  async function loadBuildings(p: [number, number]) {
    const fc = await api(`/buildings?lon=${p[0]}&lat=${p[1]}&r=120`).catch(() => null);
    setBuildings(fc);
    return fc;
  }

  async function onAddress(r: GeoResult) {
    setErr("");
    setAddr({ label: r.label, lon: r.lon, lat: r.lat });
    const m = map.current!;
    m.flyTo({ center: [r.lon, r.lat], zoom: 19.5, duration: 1200 });
    marker.current?.remove();
    marker.current = new maplibregl.Marker({ color: "#1f3a5f" }).setLngLat([r.lon, r.lat]).addTo(m);
    const fc = await loadBuildings([r.lon, r.lat]);
    const hit = fc?.features.find((f: any) => pointInRing([r.lon, r.lat], f.geometry.coordinates[0]));
    setSel(hit ? [{ id: hit.properties.id, point: [r.lon, r.lat] }] : []);
  }

  async function start(manual: boolean) {
    if (!addr) return;
    setBusy(true);
    setErr("");
    try {
      const pts = sel.length ? sel.map((s) => s.point) : [[addr.lon, addr.lat]];
      const s = await api<Study>("/studies", {
        body: { address: addr.label, lon: pts[0][0], lat: pts[0][1], points: pts, source, manual, clientName },
      });
      await refresh();
      nav(`/app/etudes/${s.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="split">
      <div className="map-wrap">
        <div ref={mapEl} className="map" />
        {busy && (
          <div className="map-overlay">
            <div className="spinner" />
            <p>Analyse du relevé 3D et calcul des pans…</p>
          </div>
        )}
      </div>
      <aside className="side">
        <h1>Nouvelle étude</h1>
        <AddressSearch
          onSelect={onAddress}
          autoFocus
          near={() => {
            const c = map.current?.getCenter();
            return c ? { lon: c.lng, lat: c.lat } : null;
          }}
        />
        <p className="muted small">Ou cliquez directement sur un bâtiment de la carte.</p>
        {addr && (
          <div className="card soft">
            <div className="strong">{addr.label}</div>
            <p className="small">
              {sel.length === 0
                ? "Aucun bâtiment sélectionné : cliquez sur la toiture à mesurer."
                : sel.length === 1
                  ? "1 bâtiment sélectionné (en orange). Cliquez sur un bâtiment voisin pour l'ajouter (annexe, extension…)."
                  : `${sel.length} bâtiments sélectionnés.`}
            </p>
            <label>
              Client (facultatif)
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </label>
            <details className="small">
              <summary>Source du relevé 3D</summary>
              <select value={source} onChange={(e) => setSource(e.target.value as any)}>
                <option value="auto">Automatique (LiDAR HD IGN en priorité)</option>
                <option value="ign">LiDAR HD IGN</option>
                <option value="google" disabled={!me?.features?.google}>
                  Google Solar API{me?.features?.google ? "" : " (clé non configurée)"}
                </option>
              </select>
            </details>
            {err && <div className="alert alert-error">{err}</div>}
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => start(false)}>
              Lancer le métrage automatique
            </button>
            <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => start(true)}>
              Dessiner la toiture à la main
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
