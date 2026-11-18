import { useEffect, useRef, useState } from "react";
import { api, type GeoResult } from "../api";

export function AddressSearch({
  onSelect,
  autoFocus,
  near,
}: {
  onSelect: (r: GeoResult) => void;
  autoFocus?: boolean;
  near?: () => { lon: number; lat: number } | null;
}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const skip = useRef(false);
  useEffect(() => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    if (q.trim().length < 3) {
      setRes([]);
      return;
    }
    const t = setTimeout(() => {
      api<GeoResult[]>(
        `/geocode?q=${encodeURIComponent(q)}${(() => {
          const n = near?.();
          return n ? `&lon=${n.lon.toFixed(5)}&lat=${n.lat.toFixed(5)}` : "";
        })()}`,
      )
        .then((r) => {
          setRes(r);
          setOpen(true);
          setActive(0);
        })
        .catch(() => setRes([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (r: GeoResult) => {
    skip.current = true;
    setQ(r.label);
    setOpen(false);
    onSelect(r);
  };
  return (
    <div className="addr-search">
      <input
        autoFocus={autoFocus}
        placeholder="Adresse du bâtiment (ex. : 12 quai Job Foran, Saint-Martin-de-Ré)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => res.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !res.length) return;
          if (e.key === "ArrowDown") {
            setActive((a) => Math.min(res.length - 1, a + 1));
            e.preventDefault();
          } else if (e.key === "ArrowUp") {
            setActive((a) => Math.max(0, a - 1));
            e.preventDefault();
          } else if (e.key === "Enter") {
            pick(res[active]);
            e.preventDefault();
          }
        }}
        aria-label="Adresse"
      />
      {open && res.length > 0 && (
        <ul className="addr-results" role="listbox">
          {res.map((r, i) => (
            <li key={`${r.label}-${i}`} className={i === active ? "active" : ""} onMouseDown={() => pick(r)}>
              {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
