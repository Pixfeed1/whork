import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { LonLat } from "../../../shared/geo";
import {
  type RoofModel,
  type EdgeType,
  computeMetrics,
  EDGE_TYPES,
  EDGE_LABEL,
  ELEMENT_TYPES,
  type ElementType,
  orientationLabel,
  pitchPercent,
  vertexKey,
} from "../../../shared/roof";
import { addFace, deleteFace, deleteVertex, setEdgeType, splitFace, updateFace, addElement, updateElement, deleteElement } from "../../../shared/edit";
import { api, fmtDateTime, type Report, type Study } from "../api";
import { RoofEditor, type Selection, type Tool } from "../components/RoofEditor";
import { View3D } from "../components/View3D";
import { FACE_COLORS } from "../components/mapStyle";
import { ReportTable } from "./Reports";
import { useAuth } from "../App";

const nf = (n: number, d = 2) => n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const D2R = Math.PI / 180;

export function StudyPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me, refresh } = useAuth();
  const [study, setStudy] = useState<Study | null>(null);
  const [model, setModel] = useState<RoofModel | null>(null);
  const [past, setPast] = useState<RoofModel[]>([]);
  const [future, setFuture] = useState<RoofModel[]>([]);
  const [sel, setSel] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [eltType, setEltType] = useState<ElementType>("cheminee");
  const [labels, setLabels] = useState(true);
  const [basemap, setBasemap] = useState<"ortho" | "plan">("ortho");
  const [hl, setHl] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [fitKey, setFitKey] = useState("init");
  const [tab, setTab] = useState<"metre" | "infos" | "rapports">("metre");
  const dirtyModel = useRef(false);

  useEffect(() => {
    api<Study>(`/studies/${id}`)
      .then((s) => {
        setStudy(s);
        setModel(s.model!);
        setFitKey(`load-${s.id}`);
      })
      .catch((e) => setErr(e.message));
    api<Report[]>(`/studies/${id}/reports`).then(setReports);
  }, [id]);

  const metrics = useMemo(() => (model ? computeMetrics(model) : null), [model]);

  // ---------- historique + sauvegarde automatique ----------
  const commit = useCallback(
    (m: RoofModel) => {
      if (!model) return;
      setPast((p) => [...p.slice(-60), model]);
      setFuture([]);
      setModel(m);
      dirtyModel.current = true;
      setSaveState("dirty");
    },
    [model],
  );
  const undo = () => {
    if (!past.length || !model) return;
    setFuture((f) => [model, ...f]);
    setModel(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    dirtyModel.current = true;
    setSaveState("dirty");
    setSel(null);
  };
  const redo = () => {
    if (!future.length || !model) return;
    setPast((p) => [...p, model]);
    setModel(future[0]);
    setFuture((f) => f.slice(1));
    dirtyModel.current = true;
    setSaveState("dirty");
  };
  const save = useCallback(async () => {
    if (!model || !dirtyModel.current) return;
    dirtyModel.current = false;
    setSaveState("saving");
    try {
      const s = await api<Study>(`/studies/${id}`, { method: "PUT", body: { model } });
      setStudy((old) => (old ? { ...old, totalArea: s.totalArea, faceCount: s.faceCount, edited: s.edited } : s));
      setSaveState("saved");
    } catch (e: any) {
      dirtyModel.current = true;
      setSaveState("error");
      setErr(e.message);
    }
  }, [model, id]);
  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(save, 1200);
    return () => clearTimeout(t);
  }, [model, saveState, save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyModel.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && sel && model) {
        e.preventDefault();
        removeSelection();
      } else if (e.key === "Escape") {
        setSel(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (err && !study) return <div className="page"><div className="alert alert-error">{err}</div></div>;
  if (!study || !model || !metrics) return <div className="page">Chargement…</div>;

  const t = metrics.totals;
  const waste = me?.org?.wastePct ?? 10;
  const selFace = sel?.kind === "face" ? model.faces.find((f) => f.id === sel.id) : null;
  const selFaceM = selFace ? metrics.faces.find((f) => f.id === selFace.id) : null;
  const selEdge = sel?.kind === "edge" ? metrics.edges.find((e) => e.key === sel.key) : null;
  const selElt = sel?.kind === "element" ? model.elements?.find((e) => e.id === sel.id) : null;
  const selEltM = selElt ? metrics.elements.find((e) => e.id === selElt.id) : null;
  const meta = (model.meta ?? {}) as any;

  function removeSelection() {
    if (!model || !sel) return;
    if (sel.kind === "face") commit(deleteFace(model, sel.id));
    else if (sel.kind === "element") commit(deleteElement(model, sel.id));
    else if (sel.kind === "vertex") commit(deleteVertex(model, sel.ll));
    else if (sel.kind === "edge") commit(setEdgeType(model, sel.key, null));
    setSel(null);
  }

  async function fitFaces(m: RoofModel, ids: string[]) {
    let cur = m;
    for (const fid of ids) {
      const f = cur.faces.find((x) => x.id === fid);
      if (!f) continue;
      try {
        const r = await api<{ pitchDeg: number; azimuthDeg: number; plane: any }>("/fit-face", { body: { ring: f.ring } });
        cur = updateFace(cur, fid, { pitchDeg: r.pitchDeg, azimuthDeg: r.azimuthDeg, plane: r.plane });
      } catch {
        /* pas de relevé : on garde les valeurs saisies */
      }
    }
    return cur;
  }

  async function onAddFace(ring: LonLat[]) {
    if (!model) return;
    // pente par défaut : celle du pan voisin le plus proche, sinon 30°
    const m1 = addFace(model, ring, model.faces[0]?.pitchDeg ?? 30, 180);
    const nid = m1.faces[m1.faces.length - 1].id;
    commit(m1);
    setTool("select");
    setSel({ kind: "face", id: nid });
    setBusy("Mesure de la pente sur le relevé 3D…");
    const m2 = await fitFaces(m1, [nid]);
    setBusy("");
    if (m2 !== m1) {
      setModel(m2);
      dirtyModel.current = true;
      setSaveState("dirty");
    }
  }

  async function onSplit(a: LonLat, b: LonLat) {
    if (!model) return;
    const face =
      (selFace && selFace.ring.some((p) => vertexKey(p) === vertexKey(a)) && selFace.ring.some((p) => vertexKey(p) === vertexKey(b)) && selFace) ||
      model.faces.find((f) => f.ring.some((p) => vertexKey(p) === vertexKey(a)) && f.ring.some((p) => vertexKey(p) === vertexKey(b)));
    if (!face) return setErr("Les deux sommets doivent appartenir au même pan.");
    const r = splitFace(model, face.id, a, b);
    if (!r) return setErr("Découpe impossible : choisissez deux sommets non voisins du même pan.");
    setErr("");
    commit(r.model);
    setTool("select");
    setBusy("Mesure des pentes des nouveaux pans…");
    const m2 = await fitFaces(r.model, r.ids);
    setBusy("");
    setModel(m2);
    dirtyModel.current = true;
    setSaveState("dirty");
  }

  async function reanalyze() {
    if (!confirm("Relancer la détection automatique ? Vos corrections manuelles seront remplacées (vous pourrez annuler).")) return;
    setBusy("Nouvelle analyse du relevé 3D…");
    setErr("");
    try {
      const s = await api<Study>(`/studies/${id}/analyze`, { body: {} });
      setPast((p) => [...p, model!]);
      setModel(s.model!);
      setStudy(s);
      setFitKey(`re-${Date.now()}`);
      setSel(null);
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  async function makeReport() {
    setBusy("Génération du rapport PDF…");
    setErr("");
    try {
      await save();
      const r = await api<Report>(`/studies/${id}/reports`, { method: "POST" });
      setReports(await api<Report[]>(`/studies/${id}/reports`));
      window.open(`/api/reports/${r.id}/pdf`, "_blank");
      setTab("rapports");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy("");
    }
  }

  const saveLabel = { saved: "Enregistré", dirty: "Modifications…", saving: "Enregistrement…", error: "Erreur d'enregistrement" }[saveState];

  return (
    <div className="split study">
      <div className="editor-col">
        <div className="toolbar" role="toolbar">
          {(
            [
              ["select", "↖", "Sélection / déplacer"],
              ["draw", "✎", "Dessiner un pan"],
              ["insert", "＋", "Ajouter un sommet"],
              ["split", "✂", "Découper un pan"],
              ["element", "▣", "Cheminée / fenêtre"],
            ] as [Tool, string, string][]
          ).map(([k, icon, label]) => (
            <button key={k} className={`tool ${tool === k ? "active" : ""}`} onClick={() => setTool(k)} title={label}>
              <span className="tool-icon">{icon}</span>
              <span className="tool-label">{label}</span>
            </button>
          ))}
          {tool === "element" && (
            <select className="tool" value={eltType} onChange={(e) => setEltType(e.target.value as ElementType)} aria-label="Type d'élément">
              {ELEMENT_TYPES.map((x) => (
                <option key={x.type} value={x.type}>
                  {x.label}
                </option>
              ))}
            </select>
          )}
          <span className="sep" />
          <button className="tool" onClick={undo} disabled={!past.length} title="Annuler (Ctrl+Z)">
            <span className="tool-icon">↶</span>
          </button>
          <button className="tool" onClick={redo} disabled={!future.length} title="Rétablir (Ctrl+Y)">
            <span className="tool-icon">↷</span>
          </button>
          <span className="sep" />
          <label className="tool check">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Cotes
          </label>
          <select className="tool" value={basemap} onChange={(e) => setBasemap(e.target.value as any)} aria-label="Fond de carte">
            <option value="ortho">Photo aérienne</option>
            <option value="plan">Plan</option>
          </select>
          <span className={`save-state ${saveState}`}>{saveLabel}</span>
        </div>
        <RoofEditor
          model={model}
          metrics={metrics}
          selection={sel}
          onSelect={setSel}
          tool={tool}
          onModel={commit}
          onAddFace={onAddFace}
          onSplit={onSplit}
          onAddElement={(ll) => {
            const r = addElement(model, eltType, ll);
            commit(r.model);
            setTool("select");
            setSel({ kind: "element", id: r.id });
          }}
          showLabels={labels}
          highlightType={hl}
          basemap={basemap}
          fitKey={fitKey}
        />
        {busy && (
          <div className="busy-bar">
            <div className="spinner small" /> {busy}
          </div>
        )}
      </div>

      <aside className="side">
        <div className="side-head">
          <button className="btn-link" onClick={() => nav("/app")}>
            ← Études
          </button>
          <h1 title={study.address}>{study.title || study.address}</h1>
          {study.title && <div className="muted small">{study.address}</div>}
          <div className="row gap">
            <button className="btn btn-primary" onClick={makeReport} disabled={!!busy || !model.faces.length}>
              Générer le rapport PDF
            </button>
            <button className="btn" onClick={reanalyze} disabled={!!busy}>
              Relancer la détection
            </button>
          </div>
        </div>
        {err && <div className="alert alert-error">{err}</div>}
        {(meta.warnings ?? []).map((w: string) => (
          <div className="alert alert-warn" key={w}>
            {w}
          </div>
        ))}

        {/* --- élément sélectionné --- */}
        {selFace && selFaceM && (
          <div className="card sel-card">
            <div className="row between">
              <h3>
                <span className="dot" style={{ background: FACE_COLORS[(selFaceM.index - 1) % FACE_COLORS.length] }} /> Pan {selFaceM.index}
              </h3>
              <button className="btn-link" onClick={() => setSel(null)}>
                Fermer
              </button>
            </div>
            <div className="kv">
              <span>Surface</span>
              <b>{nf(selFaceM.area)} m²</b>
              <span>Au sol</span>
              <b>{nf(selFaceM.area2D)} m²</b>
            </div>
            <div className="form-grid tight">
              <label>
                Pente (°)
                <input
                  type="number"
                  min={0}
                  max={85}
                  step={0.5}
                  value={selFace.pitchDeg}
                  onChange={(e) => commit(updateFace(model, selFace.id, { pitchDeg: Math.max(0, Math.min(85, Number(e.target.value) || 0)), plane: null }))}
                />
              </label>
              <label>
                Pente (%)
                <input
                  type="number"
                  min={0}
                  max={1000}
                  step={1}
                  value={Math.round(pitchPercent(selFace.pitchDeg))}
                  onChange={(e) =>
                    commit(updateFace(model, selFace.id, { pitchDeg: Math.round((Math.atan((Number(e.target.value) || 0) / 100) / D2R) * 10) / 10, plane: null }))
                  }
                />
              </label>
              <label className="span2">
                Orientation de la pente : {orientationLabel(selFace.azimuthDeg)} ({Math.round(selFace.azimuthDeg)}°)
                <div className="compass">
                  {["N", "NE", "E", "SE", "S", "SO", "O", "NO"].map((n, i) => (
                    <button
                      key={n}
                      className={`btn btn-sm ${orientationLabel(selFace.azimuthDeg) === n ? "btn-primary" : ""}`}
                      onClick={() => commit(updateFace(model, selFace.id, { azimuthDeg: i * 45, plane: null }))}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </label>
            </div>
            <div className="row gap wrap">
              <button
                className="btn btn-sm"
                onClick={async () => {
                  setBusy("Mesure sur le relevé 3D…");
                  const m2 = await fitFaces(model, [selFace.id]);
                  setBusy("");
                  if (m2 === model) setErr("Pas de relevé 3D exploitable pour ce pan.");
                  else commit(m2);
                }}
              >
                Mesurer pente et orientation (relevé 3D)
              </button>
              <button
                className="btn btn-sm"
                onClick={() => commit(updateFace(model, selFace.id, { azimuthDeg: (selFace.azimuthDeg + 180) % 360, plane: null }))}
              >
                Inverser le sens
              </button>
              <button className="btn btn-sm btn-danger-ghost" onClick={removeSelection}>
                Supprimer le pan
              </button>
            </div>
          </div>
        )}
        {selEdge && (
          <div className="card sel-card">
            <div className="row between">
              <h3>
                <span className="dot" style={{ background: EDGE_TYPES.find((e) => e.type === selEdge.type)!.color }} /> Arête
              </h3>
              <button className="btn-link" onClick={() => setSel(null)}>
                Fermer
              </button>
            </div>
            <div className="kv">
              <span>Longueur</span>
              <b>{nf(selEdge.length)} m</b>
              <span>Au sol</span>
              <b>{nf(selEdge.length2D)} m</b>
              <span>Inclinaison</span>
              <b>{nf(selEdge.slopeDeg, 1)}°</b>
            </div>
            <label>
              Type d'arête
              <select
                value={selEdge.overridden ? selEdge.type : ""}
                onChange={(e) => commit(setEdgeType(model, selEdge.key, (e.target.value || null) as EdgeType | null))}
              >
                <option value="">Automatique ({EDGE_LABEL[selEdge.autoType]})</option>
                {EDGE_TYPES.map((x) => (
                  <option key={x.type} value={x.type}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {selElt && selEltM && (
          <div className="card sel-card">
            <div className="row between">
              <h3>
                <span className="dot" style={{ background: ELEMENT_TYPES.find((x) => x.type === selElt.type)!.color }} /> {selEltM.label} {selEltM.index}
              </h3>
              <button className="btn-link" onClick={() => setSel(null)}>
                Fermer
              </button>
            </div>
            {selElt.auto && <div className="alert alert-warn small">Détectée automatiquement : vérifiez sa présence et ses dimensions.</div>}
            <div className="form-grid tight">
              <label className="span2">
                Type
                <select value={selElt.type} onChange={(e) => commit(updateElement(model, selElt.id, { type: e.target.value as ElementType }))}>
                  {ELEMENT_TYPES.map((x) => (
                    <option key={x.type} value={x.type}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Largeur (m)
                <input
                  type="number"
                  min={0.1}
                  max={30}
                  step={0.05}
                  value={selElt.width}
                  onChange={(e) => commit(updateElement(model, selElt.id, { width: Math.max(0.1, Math.min(30, Number(e.target.value) || 0.1)) }))}
                />
              </label>
              <label>
                Longueur dans la pente (m)
                <input
                  type="number"
                  min={0.1}
                  max={30}
                  step={0.05}
                  value={selElt.length}
                  onChange={(e) => commit(updateElement(model, selElt.id, { length: Math.max(0.1, Math.min(30, Number(e.target.value) || 0.1)) }))}
                />
              </label>
            </div>
            <ul className="mini-list">
              {selEltM.lines.map((l) => (
                <li key={l.key}>
                  <span>{l.label}</span>
                  <b>{nf(l.length)} ml</b>
                </li>
              ))}
            </ul>
            <p className="small muted">Glissez l'élément sur la carte pour le déplacer : il s'oriente selon la pente du pan.</p>
            <button className="btn btn-sm btn-danger-ghost" onClick={removeSelection}>
              Supprimer
            </button>
          </div>
        )}
        {sel?.kind === "vertex" && (
          <div className="card sel-card">
            <div className="row between">
              <h3>Sommet</h3>
              <button className="btn-link" onClick={() => setSel(null)}>
                Fermer
              </button>
            </div>
            <p className="small muted">Glissez le sommet sur la carte pour le déplacer (il s'accroche aux autres sommets et arêtes).</p>
            <button className="btn btn-sm btn-danger-ghost" onClick={removeSelection}>
              Supprimer le sommet
            </button>
          </div>
        )}

        <div className="tabs">
          {(
            [
              ["metre", "Métré"],
              ["infos", "Infos"],
              ["rapports", `Rapports (${reports.length})`],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>

        {tab === "metre" && (
          <>
            <div className="tiles">
              <div className="tile">
                <span>Surface de toiture</span>
                <b data-testid="total-area">{nf(t.area)} m²</b>
              </div>
              <div className="tile">
                <span>Avec chutes (+{waste} %)</span>
                <b>{nf(t.area * (1 + waste / 100))} m²</b>
              </div>
              <div className="tile">
                <span>Pans</span>
                <b>{t.faceCount}</b>
              </div>
              <div className="tile">
                <span>Pente moyenne</span>
                <b>
                  {nf(t.meanPitchDeg, 1)}° · {nf(pitchPercent(t.meanPitchDeg), 0)} %
                </b>
              </div>
            </div>
            <h3>Linéaires</h3>
            <ul className="lin-list">
              {EDGE_TYPES.map((e) => (
                <li
                  key={e.type}
                  className={`${hl === e.type ? "active" : ""} ${t.lengths[e.type] < 0.005 ? "zero" : ""}`}
                  onMouseEnter={() => setHl(e.type)}
                  onMouseLeave={() => setHl(null)}
                  onClick={() => setHl(hl === e.type ? null : e.type)}
                  title={e.help}
                >
                  <span className="swatch" style={{ background: e.color }} />
                  <span>{e.label}</span>
                  <b>{nf(t.lengths[e.type])} ml</b>
                </li>
              ))}
            </ul>
            {metrics.elements.length > 0 && (
              <>
                <h3>Éléments et raccords</h3>
                <ul className="lin-list">
                  {ELEMENT_TYPES.filter((x) => metrics.elements.some((e) => e.type === x.type)).map((x) => (
                    <li key={x.type} className="static">
                      <span className="swatch" style={{ background: x.color, height: 10, width: 10, borderRadius: 2 }} />
                      <span>{x.plural}</span>
                      <b>{metrics.elements.filter((e) => e.type === x.type).length}</b>
                    </li>
                  ))}
                  {metrics.flashing.map((f) => (
                    <li key={f.key} className="static sub">
                      <span />
                      <span>{f.label}</span>
                      <b>{nf(f.length)} ml</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3>Pans</h3>
            {model.faces.length === 0 ? (
              <p className="muted small">Aucun pan. Utilisez l'outil « Dessiner un pan ».</p>
            ) : (
              <table className="table compact">
                <thead>
                  <tr>
                    <th>N°</th>
                    <th className="num">Surface</th>
                    <th className="num">Pente</th>
                    <th>Orient.</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.faces.map((f, i) => (
                    <tr
                      key={f.id}
                      className={`clickable ${sel?.kind === "face" && sel.id === f.id ? "selected" : ""}`}
                      onClick={() => setSel({ kind: "face", id: f.id })}
                    >
                      <td>
                        <span className="dot" style={{ background: FACE_COLORS[i % FACE_COLORS.length] }} /> {f.index}
                      </td>
                      <td className="num">{nf(f.area, 1)} m²</td>
                      <td className="num">
                        {nf(f.pitchDeg, 1)}° <span className="muted">({nf(f.pitchPct, 0)} %)</span>
                      </td>
                      <td>{f.orientation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === "infos" && <View3D model={model} />}
        {tab === "infos" && (
          <StudyInfo
            study={study}
            onSaved={(s) => setStudy({ ...study, ...s })}
            meta={meta}
            onDelete={async () => {
              if (!confirm("Supprimer définitivement cette étude et ses rapports ?")) return;
              await api(`/studies/${id}`, { method: "DELETE" });
              nav("/app");
            }}
          />
        )}

        {tab === "rapports" &&
          (reports.length ? (
            <ReportTable
              rows={reports}
              onDelete={async (rid) => {
                if (!confirm("Supprimer ce rapport ?")) return;
                await api(`/reports/${rid}`, { method: "DELETE" });
                setReports(reports.filter((r) => r.id !== rid));
              }}
            />
          ) : (
            <p className="muted small">Aucun rapport généré pour cette étude.</p>
          ))}
      </aside>
    </div>
  );
}

function StudyInfo({ study, onSaved, meta, onDelete }: { study: Study; onSaved: (s: Partial<Study>) => void; meta: any; onDelete: () => void }) {
  const [f, setF] = useState({ title: study.title, address: study.address, clientName: study.clientName, notes: study.notes });
  const [msg, setMsg] = useState("");
  const d = meta.diagnostics ?? {};
  return (
    <>
      <form
        className="form-grid tight"
        onSubmit={async (e) => {
          e.preventDefault();
          await api(`/studies/${study.id}`, { method: "PUT", body: f });
          onSaved(f);
          setMsg("Enregistré");
          setTimeout(() => setMsg(""), 2000);
        }}
      >
        <label className="span2">
          Intitulé
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex. : Réfection toiture maison Dupont" />
        </label>
        <label className="span2">
          Adresse
          <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </label>
        <label className="span2">
          Client
          <input value={f.clientName} onChange={(e) => setF({ ...f, clientName: e.target.value })} />
        </label>
        <label className="span2">
          Observations (reprises dans le rapport)
          <textarea rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <div className="span2 row gap">
          <button className="btn btn-primary">Enregistrer</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </form>
      <h3>Données utilisées</h3>
      <dl className="kv small">
        <dt>Relevé 3D</dt>
        <dd>{meta.dsmSource ?? "aucun (dessin manuel)"}</dd>
        {meta.imageryDate && (
          <>
            <dt>Date des images</dt>
            <dd>{meta.imageryDate}</dd>
          </>
        )}
        {d.confidence && (
          <>
            <dt>Confiance détection</dt>
            <dd>{d.confidence}</dd>
          </>
        )}
        {d.outline && (
          <>
            <dt>Contour</dt>
            <dd>{d.outline}</dd>
          </>
        )}
        {meta.google && (
          <>
            <dt>Contrôle Google Solar</dt>
            <dd>
              {meta.google.wholeRoofArea ? `${nf(meta.google.wholeRoofArea)} m²` : "—"} · {meta.google.segmentCount} segments · qualité{" "}
              {meta.google.imageryQuality ?? "?"}
            </dd>
          </>
        )}
        {meta.analyzedAt && (
          <>
            <dt>Analyse</dt>
            <dd>{fmtDateTime(meta.analyzedAt)}</dd>
          </>
        )}
      </dl>
      <button className="btn btn-danger-ghost" onClick={onDelete}>
        Supprimer l'étude
      </button>
    </>
  );
}
