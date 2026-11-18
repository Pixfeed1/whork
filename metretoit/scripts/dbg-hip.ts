import { makeGrid } from "../tests/synthetic";
import { segmentRoof } from "../server/analysis/segment";
const t = Math.tan(30 * Math.PI/180);
const fp:any = [[-7,-5],[7,-5],[7,5],[-7,5]];
const zf = (x:number,y:number)=> Math.abs(x)<=7&&Math.abs(y)<=5 ? 15 + t*Math.min(5-Math.abs(y),7-Math.abs(x)) : null;
const g = makeGrid(zf,[-18,-16,18,16]);
const s = segmentRoof(g,[fp],[],{overhang:0.3});
console.log("shift", s.shift);
for (const f of s.faces) console.log(f.pitchDeg.toFixed(1), f.azimuthDeg.toFixed(0), f.cells, JSON.stringify(f.ring.map(p=>p.map(v=>+v.toFixed(2)))));
