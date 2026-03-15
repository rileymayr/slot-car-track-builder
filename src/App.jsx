import { useState, useRef, useEffect, useCallback } from "react";
import { PIECES } from './pieces/aurora.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const SCALE = 18;
const TRACK_WIDTH = 3.0;
const LOOP_TOL = 0.15;
const SNAP_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const SNAP_THRESH = 10;

const CHAIN_COLORS = ["#f59e0b","#38bdf8","#a78bfa","#34d399","#fb7185","#fb923c","#e879f9","#4ade80"];
const SLOT_OFFSET = [0.75, 2.25]; // inches from outside edge



// ─── Geometry ─────────────────────────────────────────────────────────────────
const d2r = d => d * Math.PI / 180;

function exitOf(piece, entry) {
  const {x, y, angleDeg, elevIn} = entry;
  const ar = d2r(angleDeg);
  if (piece.type === "straight" || piece.type === "ramp") {
    return {x: x + Math.cos(ar)*piece.length_in, y: y + Math.sin(ar)*piece.length_in,
      angleDeg, elevIn: elevIn + piece.elev};
  }
  if (piece.type === "curve") {
    const ts = piece.turn === "L" ? -1 : 1;
    const sweep = d2r(piece.a) * ts;
    const tcr = piece.r - TRACK_WIDTH / 2;
    const pa = ar + ts * Math.PI / 2;
    const cx = x + Math.cos(pa)*tcr, cy = y + Math.sin(pa)*tcr;
    const vx = x-cx, vy = y-cy;
    const cs = Math.cos(sweep), sn = Math.sin(sweep);
    return {x: cx+vx*cs-vy*sn, y: cy+vx*sn+vy*cs,
      angleDeg: angleDeg + piece.a*ts, elevIn: elevIn + piece.elev};
  }
  return entry;
}

function buildConnectors(pieces, origin) {
  const out = [];
  let cur = {...origin};
  for (const p of pieces) {
    const entry = {...cur};
    const exit = exitOf(p, entry);
    out.push({entry, exit, piece: p});
    cur = exit;
  }
  return out;
}

function isClosed(conns) {
  if (conns.length < 2) return false;
  const f = conns[0].entry, l = conns[conns.length-1].exit;
  const ad = ((f.angleDeg - l.angleDeg) % 360 + 360) % 360;
  return Math.hypot(f.x-l.x, f.y-l.y) < LOOP_TOL && (ad < 2 || ad > 358);
}
// ─── Hit Testing ──────────────────────────────────────────────────────────────
// Returns true if world point (wx,wy) is inside a straight/ramp piece
function hitStraight(wx, wy, entry, exit, angleDeg) {
  const ar = d2r(angleDeg);
  const len = Math.hypot(exit.x - entry.x, exit.y - entry.y);
  // Transform point into piece-local space
  const dx = wx - entry.x, dy = wy - entry.y;
  const along =  dx * Math.cos(ar) + dy * Math.sin(ar);
  const perp  = -dx * Math.sin(ar) + dy * Math.cos(ar);
  return along >= -0.2 && along <= len + 0.2 && Math.abs(perp) <= TRACK_WIDTH / 2 + 0.2;
}

// Returns true if world point is inside a curve piece's annular sector
function hitCurve(wx, wy, entry, piece) {
  const ar = d2r(entry.angleDeg);
  const ts2 = piece.turn === "L" ? 1 : -1;
  const tcr = piece.r - TRACK_WIDTH / 2;
  const pa = ar + ts2 * Math.PI / 2;
  const cx = entry.x + Math.cos(pa) * tcr;
  const cy = entry.y + Math.sin(pa) * tcr;
  const dist = Math.hypot(wx - cx, wy - cy);
  if (dist < piece.r - TRACK_WIDTH - 0.3 || dist > piece.r + 0.3) return false;
  // Check angle within sweep
  const startA = Math.atan2(entry.y - cy, entry.x - cx);
  const sweep = d2r(piece.a) * ts2;
  const ptA = Math.atan2(wy - cy, wx - cx);
  // Normalize angle difference to [0, sweep] range
  let diff = ptA - startA;
  if (sweep > 0) {
    while (diff < 0) diff += Math.PI * 2;
    while (diff > Math.PI * 2) diff -= Math.PI * 2;
    return diff <= sweep + 0.05;
  } else {
    while (diff > 0) diff -= Math.PI * 2;
    while (diff < -Math.PI * 2) diff += Math.PI * 2;
    return diff >= sweep - 0.05;
  }
}

// Find which piece (if any) was clicked. Returns {chainIdx, pieceIdx} or null.
function hitTestPieces(wx, wy, chains, marker) {
  // Test active chain first (on top), then others
  const order = [...chains.keys()];
  for (const ci of order) {
    const origin = chainOrigin(marker, ci);
    const conns = buildConnectors(chains[ci].pieces, origin);
    for (let pi = conns.length - 1; pi >= 0; pi--) {
      const {entry, exit, piece} = conns[pi];
      let hit = false;
      if (piece.type === "straight" || piece.type === "ramp") {
        hit = hitStraight(wx, wy, entry, exit, entry.angleDeg);
      } else if (piece.type === "curve") {
        hit = hitCurve(wx, wy, entry, piece);
      }
      if (hit) return {chainIdx: ci, pieceIdx: pi};
    }
  }
  return null;
}



// Per-chain origin: offset perpendicular to start marker direction
function chainOrigin(marker, chainIdx) {
  const ar = d2r(marker.angleDeg);
  const perpX = -Math.sin(ar), perpY = Math.cos(ar);
  return {
    x: marker.x + perpX * chainIdx * TRACK_WIDTH,
    y: marker.y + perpY * chainIdx * TRACK_WIDTH,
    angleDeg: marker.angleDeg,
    elevIn: 0,
  };
}

function allLaneLengths(chains, marker) {
  const result = [];
  chains.forEach((chain, ci) => {
    const origin = chainOrigin(marker, ci);
    let l1 = 0, l2 = 0;
    for (const p of chain.pieces) {
      if (p.type === "straight" || p.type === "ramp") { l1 += p.length_in; l2 += p.length_in; }
      else if (p.type === "curve") {
        const rad = d2r(p.a);
        // For a right turn, lane 1 (offset 0.75 from outside) is the outer lane — longer arc.
        // For a left turn, the outside edge flips, so lane 2 becomes outer — lane 1 gets shorter arc.
        if (p.turn === "R") {
          l1 += Math.max(0, p.r - 0.75) * rad;
          l2 += Math.max(0, p.r - 2.25) * rad;
        } else {
          l1 += Math.max(0, p.r - 2.25) * rad;
          l2 += Math.max(0, p.r - 0.75) * rad;
        }
      }
    }
    result.push({chainIdx: ci, l1, l2});
  });
  return result;
}

// ─── Canvas Draw ──────────────────────────────────────────────────────────────
function drawCanvas(canvas, chains, marker, markerPlaced, table, vp, activeChain, selectedPiece) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = "#0f172a"; ctx.fillRect(0,0,W,H);

  // Grid
  const gs = 6*SCALE*vp.zoom;
  const ox = ((vp.px%gs)+gs)%gs, oy = ((vp.py%gs)+gs)%gs;
  ctx.strokeStyle="#1e293b"; ctx.lineWidth=1;
  for(let x=ox;x<W;x+=gs){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=oy;y<H;y+=gs){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

  const ts = (wx,wy) => ({sx: wx*SCALE*vp.zoom+vp.px, sy: wy*SCALE*vp.zoom+vp.py});
  const sc = v => v*SCALE*vp.zoom;

  // Table
  if (table.length >= 3) {
    ctx.save();
    ctx.beginPath();
    const p0 = ts(table[0][0],table[0][1]); ctx.moveTo(p0.sx,p0.sy);
    for(let i=1;i<table.length;i++){const p=ts(table[i][0],table[i][1]);ctx.lineTo(p.sx,p.sy);}
    ctx.closePath();
    ctx.fillStyle="rgba(30,41,59,0.4)"; ctx.fill();
    ctx.strokeStyle="#38bdf8"; ctx.lineWidth=2; ctx.setLineDash([8,4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  }

  // Draw each chain
  chains.forEach((chain, ci) => {
    if (!markerPlaced) return;
    const origin = chainOrigin(marker, ci);
    const conns = buildConnectors(chain.pieces, origin);
    const closed = isClosed(conns);
    const color = CHAIN_COLORS[ci % CHAIN_COLORS.length];
    const isActive = ci === activeChain;
    const alpha = isActive ? 1.0 : 0.45;

    ctx.save();
    ctx.globalAlpha = alpha;

    conns.forEach(({entry, exit, piece}, idx) => {
      ctx.save();
      // Pieces at elevation > 0 render at 70% opacity to show height visually
      const elevAlpha = entry.elevIn > 0 ? 0.7 : 1.0;
      ctx.globalAlpha = alpha * elevAlpha;
      const ar = d2r(entry.angleDeg);

      if (piece.type === "straight" || piece.type === "ramp") {
        const {sx:ex,sy:ey} = ts(entry.x,entry.y);
        const {sx:xx,sy:xy} = ts(exit.x,exit.y);
        const px=-Math.sin(ar), py=Math.cos(ar), hw=sc(TRACK_WIDTH/2);
        ctx.beginPath();
        ctx.moveTo(ex+px*hw,ey+py*hw); ctx.lineTo(ex-px*hw,ey-py*hw);
        ctx.lineTo(xx-px*hw,xy-py*hw); ctx.lineTo(xx+px*hw,xy+py*hw);
        ctx.closePath();
        ctx.fillStyle = piece.type==="ramp"?(piece.elev>0?"#1e3a5f":"#1e3a2f"):"#1e293b";
        ctx.fill();
        ctx.strokeStyle = piece.type==="ramp"?"#38bdf8":"#475569";
        ctx.lineWidth=1.5; ctx.stroke();
        // Slot lines
        SLOT_OFFSET.forEach((off,li) => {
          const o = off - TRACK_WIDTH/2;
          ctx.beginPath();
          ctx.moveTo(ex+px*sc(o),ey+py*sc(o)); ctx.lineTo(xx+px*sc(o),xy+py*sc(o));
          ctx.strokeStyle = li===0 ? color : color+"aa";
          ctx.lineWidth=2; ctx.stroke();
          ctx.beginPath(); ctx.arc(ex+px*sc(o),ey+py*sc(o),2.5,0,Math.PI*2);
          ctx.fillStyle = li===0 ? color : color+"aa"; ctx.fill();
        });
        if (piece.type==="ramp") {
          const mx=(ex+xx)/2,my=(ey+xy)/2;
          ctx.fillStyle="#38bdf8"; ctx.font=`bold ${Math.max(9,sc(0.4))}px monospace`;
          ctx.textAlign="center"; ctx.textBaseline="middle";
          ctx.fillText(piece.elev>0?"▲":"▼",mx,my);
        }
      } else if (piece.type==="curve") {
        const ts2 = piece.turn === "L" ? -1 : 1;
        const tcr = piece.r - TRACK_WIDTH/2;
        const pa = ar + ts2*Math.PI/2;
        const cx=entry.x+Math.cos(pa)*tcr, cy=entry.y+Math.sin(pa)*tcr;
        const {sx:scx,sy:scy} = ts(cx,cy);
        const startA = Math.atan2(entry.y-cy, entry.x-cx);
        const sweep = d2r(piece.a)*ts2, endA=startA+sweep, acw=sweep<0;
        const outerR=sc(piece.r), innerR=sc(Math.max(0.1,piece.r-TRACK_WIDTH));
        ctx.beginPath(); ctx.arc(scx,scy,outerR,startA,endA,acw);
        ctx.arc(scx,scy,innerR,endA,startA,!acw);
        ctx.closePath(); ctx.fillStyle="#1e293b"; ctx.fill();
        ctx.strokeStyle="#475569"; ctx.lineWidth=1.5; ctx.stroke();
        SLOT_OFFSET.forEach((off,li) => {
          const sr=sc(piece.r-off);
          ctx.beginPath(); ctx.arc(scx,scy,sr,startA,endA,acw);
          ctx.strokeStyle=li===0?color:color+"aa"; ctx.lineWidth=2; ctx.stroke();
          ctx.beginPath(); ctx.arc(scx+Math.cos(startA)*sr,scy+Math.sin(startA)*sr,2.5,0,Math.PI*2);
          ctx.fillStyle=li===0?color:color+"aa"; ctx.fill();
        });
      }

      // Piece index
      const {sx:lx,sy:ly} = ts((entry.x+exit.x)/2,(entry.y+exit.y)/2);
      ctx.fillStyle="rgba(255,255,255,0.25)";
      ctx.font=`${Math.max(8,sc(0.3))}px monospace`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(idx+1,lx,ly);
      ctx.restore();
    });

    // Highlight selected piece
    if (selectedPiece && selectedPiece.chainIdx === ci) {
      const si = selectedPiece.pieceIdx;
      if (si < conns.length) {
        const {entry, exit, piece} = conns[si];
        ctx.save();
        ctx.globalAlpha = 1.0;
        const ar = d2r(entry.angleDeg);
        if (piece.type === "straight" || piece.type === "ramp") {
          const {sx:ex,sy:ey} = ts(entry.x,entry.y);
          const {sx:xx,sy:xy} = ts(exit.x,exit.y);
          const px=-Math.sin(ar),py=Math.cos(ar),hw=sc(TRACK_WIDTH/2+0.3);
          ctx.beginPath();
          ctx.moveTo(ex+px*hw,ey+py*hw); ctx.lineTo(ex-px*hw,ey-py*hw);
          ctx.lineTo(xx-px*hw,xy-py*hw); ctx.lineTo(xx+px*hw,xy+py*hw);
          ctx.closePath();
          ctx.strokeStyle="#fff"; ctx.lineWidth=2.5; ctx.setLineDash([4,3]); ctx.stroke(); ctx.setLineDash([]);
        } else if (piece.type === "curve") {
          const ts2=piece.turn==="L"?1:-1;
          const tcr=piece.r-TRACK_WIDTH/2;
          const pa=ar+ts2*Math.PI/2;
          const cx=entry.x+Math.cos(pa)*tcr,cy=entry.y+Math.sin(pa)*tcr;
          const {sx:scx,sy:scy}=ts(cx,cy);
          const startA=Math.atan2(entry.y-cy,entry.x-cx);
          const sweep=d2r(piece.a)*ts2,endA=startA+sweep,acw=sweep<0;
          const outerR=sc(piece.r+0.3),innerR=sc(Math.max(0.1,piece.r-TRACK_WIDTH-0.3));
          ctx.beginPath(); ctx.arc(scx,scy,outerR,startA,endA,acw);
          ctx.arc(scx,scy,innerR,endA,startA,!acw);
          ctx.closePath();
          ctx.strokeStyle="#fff"; ctx.lineWidth=2.5; ctx.setLineDash([4,3]); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }

    // Open connector indicator
    if (!closed && conns.length > 0) {
      const l = conns[conns.length-1].exit;
      const {sx,sy} = ts(l.x,l.y);
      const ar2 = d2r(l.angleDeg);
      ctx.save();
      ctx.beginPath(); ctx.arc(sx,sy,sc(0.32),0,Math.PI*2);
      ctx.fillStyle=color+"33"; ctx.fill();
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.setLineDash([4,3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(sx,sy);
      ctx.lineTo(sx+Math.cos(ar2)*sc(0.5),sy+Math.sin(ar2)*sc(0.5));
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();
      ctx.restore();
    }
    if (closed && conns.length > 0) {
      const {sx,sy} = ts(conns[0].entry.x, conns[0].entry.y);
      ctx.save();
      ctx.beginPath(); ctx.arc(sx,sy,sc(0.4),0,Math.PI*2);
      ctx.strokeStyle="#22c55e"; ctx.lineWidth=3; ctx.stroke();
      ctx.restore();
    }

    ctx.restore(); // alpha
  });

  // Start marker
  if (markerPlaced) {
    const {sx,sy} = ts(marker.x,marker.y);
    const ar = d2r(marker.angleDeg);
    ctx.save();
    // Draw parallel chain start lines
    chains.forEach((_, ci) => {
      const orig = chainOrigin(marker, ci);
      const {sx:ox2,sy:oy2} = ts(orig.x,orig.y);
      const color = CHAIN_COLORS[ci % CHAIN_COLORS.length];
      const perpX=-Math.sin(ar), perpY=Math.cos(ar);
      const hw=sc(TRACK_WIDTH/2);
      // start line for this chain
      ctx.beginPath();
      ctx.moveTo(ox2+perpX*hw, oy2+perpY*hw);
      ctx.lineTo(ox2-perpX*hw, oy2-perpY*hw);
      ctx.strokeStyle=color; ctx.lineWidth=3; ctx.stroke();
    });
    // Main marker indicator
    ctx.beginPath(); ctx.arc(sx,sy,sc(0.55),0,Math.PI*2);
    ctx.fillStyle="rgba(255,255,255,0.1)"; ctx.fill();
    ctx.strokeStyle="#fff"; ctx.lineWidth=2; ctx.stroke();
    // Direction arrow
    ctx.beginPath(); ctx.moveTo(sx,sy);
    ctx.lineTo(sx+Math.cos(ar)*sc(1.2),sy+Math.sin(ar)*sc(1.2));
    ctx.strokeStyle="#fff"; ctx.lineWidth=2; ctx.stroke();
    // Arrowhead
    const hx=sx+Math.cos(ar)*sc(1.2), hy=sy+Math.sin(ar)*sc(1.2);
    ctx.beginPath();
    ctx.moveTo(hx,hy);
    ctx.lineTo(hx+Math.cos(ar+2.4)*sc(0.35),hy+Math.sin(ar+2.4)*sc(0.35));
    ctx.lineTo(hx+Math.cos(ar-2.4)*sc(0.35),hy+Math.sin(ar-2.4)*sc(0.35));
    ctx.closePath(); ctx.fillStyle="#fff"; ctx.fill();
    // "START" label
    ctx.fillStyle="#fff"; ctx.font=`bold ${Math.max(9,sc(0.45))}px monospace`;
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("START",sx,sy-sc(1));
    ctx.restore();
  }
}


// ─── BOM ──────────────────────────────────────────────────────────────────────
function BOM({chains}) {
  const c={};
  for(const chain of chains) {
    for(const p of chain.pieces){
      const id=p.id==="rd"?"ru":p.id;
      const lbl=p.id==="rd"?"Ramp (up/down)":p.label;
      if(!c[id])c[id]={lbl,n:0}; c[id].n++;
    }
  }
  if(!Object.keys(c).length) return null;
  return (
      <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
        {Object.values(c).map(e=>(
            <div key={e.lbl} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"3px 8px",fontSize:11,fontFamily:"monospace",color:"#94a3b8",display:"flex",gap:6,alignItems:"center"}}>
              <span style={{color:"#f1f5f9"}}>{e.lbl}</span>
              <span style={{background:"#334155",borderRadius:3,padding:"1px 5px",color:"#fbbf24",fontWeight:"bold"}}>×{e.n}</span>
            </div>
        ))}
      </div>
  );
}


// ─── Assembly Guide ───────────────────────────────────────────────────────────
function AssemblyGuide({chains}) {
  const active = chains.filter(c => c.pieces.length > 0);
  if (!active.length) return null;
  return (
      <div style={{marginTop:10}}>
        <div style={{fontSize:10,color:"#475569",fontFamily:"monospace",marginBottom:6}}>ASSEMBLY ORDER</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:12,alignItems:"flex-start"}}>
          {active.map((chain, ci) => {
            const color = CHAIN_COLORS[chain.id % CHAIN_COLORS.length];
            return (
                <div key={chain.id} style={{minWidth:160,flex:1}}>
                  <div style={{fontSize:10,color,fontFamily:"monospace",fontWeight:"bold",marginBottom:4,
                    borderBottom:`1px solid ${color}33`,paddingBottom:3}}>
                    {chain.label}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:1}}>
                    {chain.pieces.map((p, pi) => (
                        <div key={pi} style={{display:"flex",gap:5,alignItems:"baseline"}}>
                    <span style={{fontSize:9,color:"#475569",fontFamily:"monospace",
                      minWidth:18,textAlign:"right",flexShrink:0}}>
                      {pi+1}.
                    </span>
                          <span style={{fontSize:11,color:"#e2e8f0",fontFamily:"monospace"}}>
                      {p.label}
                    </span>
                        </div>
                    ))}
                  </div>
                </div>
            );
          })}
        </div>
      </div>
  );
}

// ─── Quick Pick ───────────────────────────────────────────────────────────────
function QuickPick({onSelect,onClose,lastPiece}) {
  const common=PIECES.filter(p=>p.tags.includes("common"));
  const similar=lastPiece?PIECES.filter(p=>p.type===lastPiece.type&&p.id!==lastPiece.id).slice(0,4):[];
  const groups=[{lbl:"COMMON",ps:common},...(similar.length?[{lbl:"SIMILAR",ps:similar}]:[])];
  return (
      <div style={{background:"#0f172a",border:"1px solid #334155",borderRadius:8,padding:12,boxShadow:"0 8px 32px rgba(0,0,0,0.6)",minWidth:230,marginBottom:8}}>
        {groups.map(g=>(
            <div key={g.lbl} style={{marginBottom:8}}>
              <div style={{fontSize:9,color:"#475569",fontFamily:"monospace",marginBottom:4}}>{g.lbl}</div>
              {g.ps.map(p=>(
                  <button key={p.id} onClick={()=>onSelect(p)}
                          onMouseEnter={e=>e.currentTarget.style.background="#334155"}
                          onMouseLeave={e=>e.currentTarget.style.background="#1e293b"}
                          style={{display:"block",width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"5px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",cursor:"pointer",textAlign:"left",marginBottom:2}}>
                    {p.label}
                  </button>
              ))}
            </div>
        ))}
        <button onClick={onClose} style={{width:"100%",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#64748b",fontSize:11,fontFamily:"monospace",cursor:"pointer",padding:4}}>
          Browse All ▾
        </button>
      </div>
  );
}

// ─── Palette ──────────────────────────────────────────────────────────────────
function Palette({onAdd,filter,setFilter}) {
  const tags=["all","common","straight","curve","ramp","elevation"];
  const filtered=PIECES.filter(p=>filter==="all"||p.tags.includes(filter));
  return (
      <div style={{width:196,background:"#0f172a",borderRight:"1px solid #1e293b",display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:"10px 10px 6px",borderBottom:"1px solid #1e293b"}}>
          <div style={{fontSize:10,color:"#475569",fontFamily:"monospace",marginBottom:7}}>PIECE LIBRARY</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
            {tags.map(t=>(
                <button key={t} onClick={()=>setFilter(t)} style={{background:filter===t?"#1d4ed8":"#1e293b",border:`1px solid ${filter===t?"#3b82f6":"#334155"}`,borderRadius:3,padding:"2px 6px",color:filter===t?"#fff":"#64748b",fontSize:9,fontFamily:"monospace",cursor:"pointer"}}>{t}</button>
            ))}
          </div>
        </div>
        <div style={{overflowY:"auto",flex:1,padding:"5px 7px"}}>
          {filtered.map(p=>(
              <button key={p.id} onClick={()=>onAdd(p)}
                      onMouseEnter={e=>e.currentTarget.style.background="#334155"}
                      onMouseLeave={e=>e.currentTarget.style.background="#1e293b"}
                      style={{display:"block",width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"6px 8px",marginBottom:3,color:"#e2e8f0",fontSize:11,fontFamily:"monospace",cursor:"pointer",textAlign:"left"}}>
                <div style={{color:"#f1f5f9"}}>{p.label}</div>
                <div style={{fontSize:9,color:"#475569",marginTop:1}}>{p.tags.join(" · ")}</div>
              </button>
          ))}
        </div>
      </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
const mkChain = (idx) => ({id: idx, label: `Chain ${idx+1}`, pieces: []});

export default function App() {
  const canvasRef = useRef(null);
  const pendingRef = useRef(null);
  const prevSegIdx = useRef(null);

  // ── Layout state ────────────────────────────────────────────────────────────
  const [chains, setChains] = useState([mkChain(0)]);
  const [activeChain, setActiveChain] = useState(0);
  const [marker, setMarker] = useState({x:20, y:15, angleDeg:0});
  const [markerPlaced, setMarkerPlaced] = useState(false);
  const [placingMarker, setPlacingMarker] = useState(false);
  const [draggingMarker, setDraggingMarker] = useState(false);

  const [table, setTable] = useState([[0,0],[108,0],[108,60],[0,60]]);
  const [showQP, setShowQP] = useState(false);
  const [filter, setFilter] = useState("common");
  const [layoutName, setLayoutName] = useState("My Layout");

  // ── Viewport ────────────────────────────────────────────────────────────────
  const [vp, setVp] = useState({zoom:1, px:40, py:40});
  const [panning, setPanning] = useState(false);
  const [panStart, setPanStart] = useState(null);

  // ── Table drawing ────────────────────────────────────────────────────────────
  const [tMode, setTMode] = useState(false);
  const [draft, setDraft] = useState([]);
  const [mPos, setMPos] = useState(null);
  const [snapPt, setSnapPt] = useState(null);
  const [isSnapped, setIsSnapped] = useState(false);
  const [snapAng, setSnapAng] = useState(null);
  const [pendSeg, setPendSeg] = useState(null);
  const [editSide, setEditSide] = useState(null);
  // Selected piece for replace/remove
  const [selectedPiece, setSelectedPiece] = useState(null); // {chainIdx, pieceIdx, screenX, screenY}
  const [popupMode, setPopupMode] = useState("replace"); // "replace" | "add"
  const [popupTypeFilter, setPopupTypeFilter] = useState(null); // null = all, or "straight"/"curve"/"ramp"

  // ── Presets ─────────────────────────────────────────────────────────────────
  const BUILTIN_PRESETS = [
    {name:'Ping Pong (108"×60")', polygon:[[0,0],[108,0],[108,60],[0,60]]},
    {name:'Card Table (34"×34")', polygon:[[0,0],[34,0],[34,34],[0,34]]},
    {name:'4\'×8\' Sheet (96"×48")', polygon:[[0,0],[96,0],[96,48],[0,48]]},
  ];
  const [customPresets, setCustomPresets] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("sct-table-presets")||"[]");}catch{return [];}
  });
  const saveCustomPresets = p => {
    setCustomPresets(p);
    try{localStorage.setItem("sct-table-presets",JSON.stringify(p));}catch{}
  };
  const [showPresets, setShowPresets] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState("");

  // ── helpers ─────────────────────────────────────────────────────────────────
  // Convert canvas-relative CSS pixels to world inches.
  // Uses the canvas's actual pixel:CSS ratio to correct for any scaling.
  const s2w = useCallback((sx,sy)=>{
    const c = canvasRef.current;
    const scaleX = c ? c.width / c.offsetWidth : 1;
    const scaleY = c ? c.height / c.offsetHeight : 1;
    return {
      x: (sx * scaleX - vp.px) / (SCALE * vp.zoom),
      y: (sy * scaleY - vp.py) / (SCALE * vp.zoom),
    };
  },[vp]);
  const w2s = useCallback((wx,wy)=>({sx:wx*SCALE*vp.zoom+vp.px, sy:wy*SCALE*vp.zoom+vp.py}),[vp]);

  const getSnap = useCallback((raw,d)=>{
    const dr = d||draft;
    if(!dr.length) return {pt:raw,snapped:false};
    const [lx,ly]=dr[dr.length-1];
    const dx=raw.x-lx,dy=raw.y-ly,dist=Math.hypot(dx,dy);
    if(dist<0.5) return {pt:raw,snapped:false};
    const ang=((Math.atan2(dy,dx)*180/Math.PI)+360)%360;
    let best=null,bestD=Infinity;
    for(const a of SNAP_ANGLES){let d2=Math.abs(ang-a);if(d2>180)d2=360-d2;if(d2<bestD){bestD=d2;best=a;}}
    if(bestD<=SNAP_THRESH){
      const r=best*Math.PI/180;
      return {pt:{x:+(lx+Math.cos(r)*dist).toFixed(2),y:+(ly+Math.sin(r)*dist).toFixed(2)},snapped:true,snapAngle:best};
    }
    return {pt:raw,snapped:false};
  },[draft]);

  // Check if click is near the start marker (in world coords)
  const nearMarker = useCallback((wx,wy)=>{
    if(!markerPlaced) return false;
    return Math.hypot(wx-marker.x, wy-marker.y) < 1.2;
  },[markerPlaced,marker]);

  // ── resize ───────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const resize=()=>{const c=canvasRef.current;if(!c)return;c.width=c.parentElement.clientWidth;c.height=c.parentElement.clientHeight;};
    resize(); window.addEventListener("resize",resize); return()=>window.removeEventListener("resize",resize);
  },[]);

  // ── render ───────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    drawCanvas(canvas,chains,marker,markerPlaced,table,vp,activeChain,selectedPiece);

    if(!tMode&&!placingMarker) return;
    const ctx=canvas.getContext("2d");
    const toS=(wx,wy)=>({sx:wx*SCALE*vp.zoom+vp.px,sy:wy*SCALE*vp.zoom+vp.py});

    // Placing marker mode overlay
    if(placingMarker&&mPos) {
      ctx.save();
      ctx.strokeStyle="#fff"; ctx.lineWidth=1; ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(mPos.sx-12,mPos.sy); ctx.lineTo(mPos.sx+12,mPos.sy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mPos.sx,mPos.sy-12); ctx.lineTo(mPos.sx,mPos.sy+12); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font="bold 11px monospace"; ctx.fillStyle="#fff"; ctx.textAlign="center"; ctx.textBaseline="top";
      ctx.fillStyle="rgba(15,23,42,0.8)"; ctx.fillRect(mPos.sx-80,mPos.sy+16,160,22);
      ctx.fillStyle="#38bdf8"; ctx.fillText("Click to place start marker",mPos.sx,mPos.sy+20);
      ctx.restore();
      return;
    }

    if(!tMode) return;

    // Table drawing overlay
    let prevScr=null;
    if(mPos&&draft.length>0&&!pendSeg)
      prevScr=snapPt?toS(snapPt.x,snapPt.y):mPos;

    ctx.save();
    if(draft.length>0){
      const p0=toS(draft[0][0],draft[0][1]);
      ctx.strokeStyle="#f59e0b"; ctx.lineWidth=2; ctx.setLineDash([6,3]);
      ctx.beginPath(); ctx.moveTo(p0.sx,p0.sy);
      for(let i=1;i<draft.length;i++){const p=toS(draft[i][0],draft[i][1]);ctx.lineTo(p.sx,p.sy);}
      if(prevScr){ctx.strokeStyle=isSnapped?"#22c55e":"#f59e0b";ctx.lineTo(prevScr.sx,prevScr.sy);}
      ctx.stroke(); ctx.setLineDash([]);
      if(isSnapped&&prevScr){
        ctx.beginPath();ctx.arc(prevScr.sx,prevScr.sy,6,0,Math.PI*2);
        ctx.strokeStyle="#22c55e";ctx.lineWidth=2;ctx.stroke();
        ctx.fillStyle="#22c55e";ctx.font="bold 11px monospace";ctx.textAlign="left";ctx.textBaseline="middle";
        ctx.fillText(`${snapAng}°`,prevScr.sx+10,prevScr.sy-8);
      }
      draft.forEach(([wx,wy],i)=>{
        const{sx,sy}=toS(wx,wy);
        ctx.beginPath();ctx.arc(sx,sy,i===0?7:4,0,Math.PI*2);
        ctx.fillStyle=i===0?"#22c55e":"#f59e0b";ctx.fill();
        if(i===0&&draft.length>=3){ctx.strokeStyle="#fff";ctx.lineWidth=1.5;ctx.stroke();}
      });
      for(let i=0;i<draft.length-1;i++){
        if(pendSeg&&i===pendSeg.si) continue;
        const a=draft[i],b=draft[i+1];
        const{sx,sy}=toS((a[0]+b[0])/2,(a[1]+b[1])/2);
        const dist=Math.hypot(b[0]-a[0],b[1]-a[1]);
        ctx.fillStyle="rgba(15,23,42,0.85)";ctx.fillRect(sx-24,sy-10,48,20);
        ctx.fillStyle="#fbbf24";ctx.font="bold 11px monospace";ctx.textAlign="center";ctx.textBaseline="middle";
        ctx.fillText(`${dist.toFixed(1)}"`,sx,sy);
      }
    }
    const msg=pendSeg?"Type length + Enter  ·  click next corner to skip"
        :draft.length===0?"Click to place first corner"
            :draft.length<3?`Add corners (${draft.length} placed, need 3+)`
                :"Add corners  ·  Click ● or Done button to finish  ·  Esc to cancel";
    const tw=ctx.measureText(msg).width;
    ctx.fillStyle="rgba(15,23,42,0.88)";ctx.fillRect(8,8,tw+20,34);
    ctx.fillStyle=pendSeg?"#38bdf8":"#f59e0b";
    ctx.font="bold 11px monospace";ctx.textAlign="left";ctx.textBaseline="middle";
    ctx.fillText(msg,16,25);
    ctx.restore();
  },[chains,marker,markerPlaced,table,vp,activeChain,selectedPiece,tMode,placingMarker,draft,mPos,snapPt,isSnapped,snapAng,pendSeg,w2s]);

  // ── focus pending input ──────────────────────────────────────────────────────
  useEffect(()=>{
    const curIdx=pendSeg?pendSeg.si:null;
    if(curIdx!==null&&curIdx!==prevSegIdx.current&&pendingRef.current){
      pendingRef.current.focus(); pendingRef.current.select();
    }
    prevSegIdx.current=curIdx;
  },[pendSeg?.si]);

  // ── chain actions ────────────────────────────────────────────────────────────
  const addPiece = useCallback(p=>{
    setChains(prev=>prev.map((c,i)=>i===activeChain?{...c,pieces:[...c.pieces,p]}:c));
    setShowQP(false);
  },[activeChain]);

  const undoLast = ()=>{
    setChains(prev=>prev.map((c,i)=>i===activeChain?{...c,pieces:c.pieces.slice(0,-1)}:c));
    setShowQP(false);
  };

  const addChain = ()=>{
    const idx=chains.length;
    setChains(prev=>[...prev,mkChain(idx)]);
    setActiveChain(idx);
  };

  const removeChain = (idx)=>{
    const chain=chains[idx];
    if(chain.pieces.length>0){
      if(!window.confirm(`Chain ${idx+1} has ${chain.pieces.length} piece(s). Remove it anyway?`)) return;
    }
    const newChains=chains.filter((_,i)=>i!==idx).map((c,i)=>({...c,id:i,label:`Chain ${i+1}`}));
    if(!newChains.length) { setChains([mkChain(0)]); setActiveChain(0); return; }
    setChains(newChains);
    setActiveChain(Math.min(activeChain,newChains.length-1));
  };

  const clearAll = ()=>{
    setChains([mkChain(0)]); setActiveChain(0);
    setMarkerPlaced(false); setShowQP(false);
  };

  // ── table drawing ────────────────────────────────────────────────────────────
  const applyLen=(d,seg,val)=>{
    const len=parseFloat(val);
    if(!isNaN(len)&&len>0){
      const pts=d.map(p=>[...p]);
      const a=pts[seg.si],b=pts[seg.si+1];
      const dx=b[0]-a[0],dy=b[1]-a[1],cur=Math.hypot(dx,dy);
      if(cur>0.001){const sc=len/cur;pts[seg.si+1]=[+(a[0]+dx*sc).toFixed(2),+(a[1]+dy*sc).toFixed(2)];}
      return pts;
    }
    return d;
  };

  const finishDraft=useCallback((od)=>{
    const pts=od||draft;
    if(pts.length>=3)setTable(pts);
    setTMode(false);setDraft([]);setMPos(null);setSnapPt(null);setIsSnapped(false);setSnapAng(null);setPendSeg(null);
  },[draft]);

  const cancelTable=()=>{setTMode(false);setDraft([]);setMPos(null);setSnapPt(null);setIsSnapped(false);setSnapAng(null);setPendSeg(null);};

  // ── keyboard ─────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const h=e=>{
      if(tMode){
        if(e.key==="Escape"){if(pendSeg)setPendSeg(null);else cancelTable();}
        if(e.key==="Enter"&&pendSeg){const nd=applyLen(draft,pendSeg,pendSeg.value);setDraft(nd);setPendSeg(null);}
        if(e.key==="Backspace"&&!pendSeg){setDraft(d=>d.slice(0,-1));}
      }
    };
    window.addEventListener("keydown",h); return()=>window.removeEventListener("keydown",h);
  },[tMode,draft,pendSeg,finishDraft]);

  // ── mouse ────────────────────────────────────────────────────────────────────
  const onDown=e=>{
    if(tMode){
      if(e.button!==0) return;
      if(pendSeg){const nd=applyLen(draft,pendSeg,pendSeg.value);setDraft(nd);setPendSeg(null);return;}
      const rect=canvasRef.current.getBoundingClientRect();
      const raw=s2w(e.clientX-rect.left,e.clientY-rect.top);
      const{pt}=getSnap(raw);
      if(draft.length>=3){const[fx,fy]=draft[0];if(Math.hypot(raw.x-fx,raw.y-fy)<1.5){finishDraft();return;}}
      const nd=[...draft,[pt.x,pt.y]];
      setDraft(nd);
      if(nd.length>=2){
        const si=nd.length-2,a=nd[si],b=nd[si+1];
        const dist=Math.hypot(b[0]-a[0],b[1]-a[1]);
        const sm=w2s((a[0]+b[0])/2,(a[1]+b[1])/2);
        setPendSeg({si,value:dist.toFixed(1),sx:sm.sx,sy:sm.sy});
      }
      return;
    }
    if(placingMarker){
      if(e.button!==0) return;
      const rect=canvasRef.current.getBoundingClientRect();
      const w=s2w(e.clientX-rect.left,e.clientY-rect.top);
      setMarker(m=>({...m,x:w.x,y:w.y}));
      setMarkerPlaced(true);
      setPlacingMarker(false);
      return;
    }
    // Check click on a track piece (left click, not alt)
    if(e.button===0&&!e.altKey&&markerPlaced&&!tMode&&!placingMarker){
      const rect=canvasRef.current.getBoundingClientRect();
      const w=s2w(e.clientX-rect.left,e.clientY-rect.top);
      // Marker drag takes priority
      if(nearMarker(w.x,w.y)){setDraggingMarker(true);return;}
      const hit=hitTestPieces(w.x,w.y,chains,marker);
      if(hit){
        const conns=buildConnectors(chains[hit.chainIdx].pieces,chainOrigin(marker,hit.chainIdx));
        const midWorld={x:(conns[hit.pieceIdx].entry.x+conns[hit.pieceIdx].exit.x)/2,y:(conns[hit.pieceIdx].entry.y+conns[hit.pieceIdx].exit.y)/2};
        const midScreen=w2s(midWorld.x,midWorld.y);
        const hitPiece = chains[hit.chainIdx]?.pieces[hit.pieceIdx];
        setSelectedPiece({...hit,screenX:midScreen.sx,screenY:midScreen.sy});
        setPopupMode("replace");
        setPopupTypeFilter(hitPiece?.type || null);
        setActiveChain(hit.chainIdx);
        return;
      }
      // Click on empty canvas dismisses selection
      setSelectedPiece(null);
      return;
    }
    // Check drag on marker
    if(e.button===0&&markerPlaced){
      const rect=canvasRef.current.getBoundingClientRect();
      const w=s2w(e.clientX-rect.left,e.clientY-rect.top);
      if(nearMarker(w.x,w.y)){setDraggingMarker(true);return;}
    }
    if(e.button===1||(e.button===0&&e.altKey)){
      setPanning(true);
      {
        const rect3=canvasRef.current?.getBoundingClientRect();
        const c3=canvasRef.current;
        const sX3=c3?c3.width/c3.offsetWidth:1,sY3=c3?c3.height/c3.offsetHeight:1;
        const csx=(e.clientX-rect3.left)*sX3, csy=(e.clientY-rect3.top)*sY3;
        setPanStart({x:csx-vp.px,y:csy-vp.py});
      }
    }
  };

  const onMove=e=>{
    const rect=canvasRef.current?.getBoundingClientRect();
    if(!rect) return;
    const sx=e.clientX-rect.left,sy=e.clientY-rect.top;
    if(tMode||placingMarker) setMPos({sx,sy});
    if(tMode){
      const raw=s2w(sx,sy);
      const{pt,snapped,snapAngle}=getSnap(raw);
      setSnapPt(pt);setIsSnapped(snapped);setSnapAng(snapAngle||null);
    }
    if(draggingMarker){
      const w=s2w(sx,sy);
      setMarker(m=>({...m,x:w.x,y:w.y}));
      return;
    }
    if(panning&&panStart){
      const rect4=canvasRef.current?.getBoundingClientRect();
      const c4=canvasRef.current;
      const sX4=c4?c4.width/c4.offsetWidth:1,sY4=c4?c4.height/c4.offsetHeight:1;
      const csx4=(e.clientX-rect4.left)*sX4,csy4=(e.clientY-rect4.top)*sY4;
      setVp(v=>({...v,px:csx4-panStart.x,py:csy4-panStart.y}));
    }
  };

  const onUp=()=>{setPanning(false);setPanStart(null);setDraggingMarker(false);};
  const onWheel=e=>{
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const c = canvasRef.current;
    const scaleX = c ? c.width / c.offsetWidth : 1;
    const scaleY = c ? c.height / c.offsetHeight : 1;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setVp(v => {
      const newZoom = Math.max(0.2, Math.min(5, v.zoom * factor));
      // Keep the world point under the cursor stationary:
      // worldX = (mouseX - px) / (SCALE * zoom)  =>  px = mouseX - worldX * SCALE * zoom
      const worldX = (mouseX - v.px) / (SCALE * v.zoom);
      const worldY = (mouseY - v.py) / (SCALE * v.zoom);
      return {
        zoom: newZoom,
        px: mouseX - worldX * SCALE * newZoom,
        py: mouseY - worldY * SCALE * newZoom,
      };
    });
  };

  // ── derived ──────────────────────────────────────────────────────────────────
  const activePieces = chains[activeChain]?.pieces || [];

  const laneData = markerPlaced ? allLaneLengths(chains,marker) : [];
  const allClosed = markerPlaced && chains.every(c=>{
    if(!c.pieces.length) return false;
    const origin=chainOrigin(marker,chains.indexOf(c));
    return isClosed(buildConnectors(c.pieces,origin));
  });
  const anyClosed = markerPlaced && chains.some(c=>{
    if(!c.pieces.length) return false;
    const origin=chainOrigin(marker,chains.indexOf(c));
    return isClosed(buildConnectors(c.pieces,origin));
  });

  // ── file ops ─────────────────────────────────────────────────────────────────
  const saveFile=()=>{
    const data={version:2,library:"Aurora",name:layoutName,
      table:{polygon_in:table},
      marker:{x:marker.x,y:marker.y,angleDeg:marker.angleDeg,placed:markerPlaced},
      chains:chains.map(c=>({id:c.id,label:c.label,pieces:c.pieces.map(p=>({id:p.id}))}))};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
    Object.assign(document.createElement("a"),{href:url,download:`${layoutName.replace(/\s+/g,"_")}.sct`}).click();
    URL.revokeObjectURL(url);
  };

  const loadFile=e=>{
    const file=e.target.files[0];if(!file)return;
    const r=new FileReader();
    r.onload=ev=>{
      try{
        const d=JSON.parse(ev.target.result);
        if(d.table?.polygon_in)setTable(d.table.polygon_in);
        if(d.name)setLayoutName(d.name);
        if(d.marker){setMarker({x:d.marker.x,y:d.marker.y,angleDeg:d.marker.angleDeg||0});setMarkerPlaced(d.marker.placed||false);}
        if(d.chains){
          setChains(d.chains.map((c,i)=>({id:i,label:c.label||`Chain ${i+1}`,pieces:(c.pieces||[]).map(p=>PIECES.find(l=>l.id===p.id)).filter(Boolean)})));
          setActiveChain(0);
        } else if(d.layout?.pieces){
          // backwards compat with v1
          setChains([{id:0,label:"Chain 1",pieces:(d.layout.pieces||[]).map(p=>PIECES.find(l=>l.id===p.id)).filter(Boolean)}]);
          setActiveChain(0);
        }
      }catch{alert("Invalid .sct file");}
    };
    r.readAsText(file);e.target.value="";
  };

  const exportBOM=()=>{
    const rows = [];
    // BOM summary
    rows.push("BILL OF MATERIALS");
    rows.push("Piece,Count");
    const c={};
    for(const chain of chains)for(const p of chain.pieces){
      const id=p.id==="rd"?"ru":p.id;
      const lbl=p.id==="rd"?"Ramp (physical)":p.label;
      if(!c[id])c[id]={lbl,n:0};c[id].n++;
    }
    Object.values(c).forEach(e=>rows.push(`"${e.lbl}",${e.n}`));
    // Assembly order per chain
    chains.filter(ch=>ch.pieces.length>0).forEach(ch=>{
      rows.push("");
      rows.push(`ASSEMBLY ORDER — ${ch.label}`);
      rows.push("Step,Piece");
      ch.pieces.forEach((p,i)=>rows.push(`${i+1},"${p.label}"`));
    });
    const url=URL.createObjectURL(new Blob([rows.join("\n")],{type:"text/csv"}));
    Object.assign(document.createElement("a"),{href:url,download:`${layoutName.replace(/\s+/g,"_")}_BOM.csv`}).click();
    URL.revokeObjectURL(url);
  };

  const Btn=({children,onClick,active,color,disabled})=>(
      <button onClick={onClick} disabled={disabled} style={{background:active?(color?`rgba(${color},0.15)`:"rgba(29,78,216,0.2)"):"#1e293b",border:`1px solid ${active?(color?`rgb(${color})`:"#3b82f6"):"#334155"}`,borderRadius:4,padding:"4px 10px",color:disabled?"#334155":active?(color?`rgb(${color})`:"#60a5fa"):"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:disabled?"default":"pointer"}}>{children}</button>
  );

  const activeColor = CHAIN_COLORS[activeChain % CHAIN_COLORS.length];

  return (
      <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#0f172a",color:"#e2e8f0",fontFamily:"monospace",overflow:"hidden"}}>

        {/* ── Toolbar ── */}
        <div style={{display:"flex",alignItems:"center",gap:7,padding:"7px 12px",background:"#020617",borderBottom:"1px solid #1e293b",flexShrink:0,flexWrap:"wrap"}}>
          <span style={{fontSize:13,fontWeight:"bold",color:"#38bdf8",marginRight:2}}>🏎 SLOT TRACK</span>

          <input value={layoutName} onChange={e=>setLayoutName(e.target.value)} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"3px 8px",color:"#f1f5f9",fontFamily:"monospace",fontSize:11,width:130}}/>

          <Btn onClick={clearAll}>New</Btn>
          <Btn onClick={saveFile}>Save .sct</Btn>
          <Btn onClick={exportBOM}>BOM CSV</Btn>

          {/* Start Marker */}
          <Btn onClick={()=>{setPlacingMarker(v=>!v);setTMode(false);}} active={placingMarker} color="56,189,248">
            {placingMarker?"📍 Click canvas…":markerPlaced?"Move Start":"📍 Place Start"}
          </Btn>
          {markerPlaced && (
              <div style={{display:"flex",gap:3,alignItems:"center"}}>
                <span style={{fontSize:9,color:"#475569"}}>DIR:</span>
                <button onClick={()=>setMarker(m=>({...m,angleDeg:(m.angleDeg-45+360)%360}))} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 7px",color:"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>↺</button>
                <span style={{fontSize:10,color:"#94a3b8",minWidth:30,textAlign:"center"}}>{marker.angleDeg}°</span>
                <button onClick={()=>setMarker(m=>({...m,angleDeg:(m.angleDeg+45)%360}))} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 7px",color:"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>↻</button>
              </div>
          )}

          {/* Chain selector */}
          {markerPlaced && (
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:9,color:"#475569"}}>CHAIN:</span>
                <select value={activeChain} onChange={e=>setActiveChain(Number(e.target.value))} style={{background:"#1e293b",border:`1px solid ${activeColor}`,borderRadius:4,padding:"3px 7px",color:activeColor,fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>
                  {chains.map((c,i)=>(
                      <option key={i} value={i} style={{color:CHAIN_COLORS[i%CHAIN_COLORS.length]}}>{c.label}</option>
                  ))}
                </select>
                <button onClick={addChain} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 8px",color:"#22c55e",fontSize:13,fontFamily:"monospace",cursor:"pointer"}} title="Add chain">+</button>
                <button onClick={()=>removeChain(activeChain)} disabled={chains.length<=1} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 8px",color:chains.length<=1?"#334155":"#ef4444",fontSize:13,fontFamily:"monospace",cursor:chains.length<=1?"default":"pointer"}} title="Remove active chain">−</button>
              </div>
          )}

          {/* Draw Table */}
          <Btn onClick={()=>{if(tMode)cancelTable();else{setTMode(true);setDraft([]);setPlacingMarker(false);}}} active={tMode} color="245,158,11">
            {tMode?"✏ Drawing…":"Draw Table"}
          </Btn>

          {/* Table presets */}
          {!tMode && (
              <div style={{position:"relative"}}>
                <Btn onClick={()=>{setShowPresets(v=>!v);setPresetNameInput("");}}>Table Presets ▾</Btn>
                {showPresets && (
                    <div onMouseDown={e=>e.stopPropagation()} style={{position:"absolute",top:"calc(100% + 6px)",left:0,background:"#0f172a",border:"1px solid #334155",borderRadius:8,padding:12,zIndex:200,minWidth:240,boxShadow:"0 8px 32px rgba(0,0,0,0.7)"}}>
                      <div style={{fontSize:9,color:"#475569",fontFamily:"monospace",marginBottom:6}}>BUILT-IN</div>
                      {BUILTIN_PRESETS.map(p=>(
                          <button key={p.name} onClick={()=>{setTable(p.polygon);setShowPresets(false);}}
                                  onMouseEnter={e=>e.currentTarget.style.background="#334155"}
                                  onMouseLeave={e=>e.currentTarget.style.background="#1e293b"}
                                  style={{display:"block",width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace",cursor:"pointer",textAlign:"left",marginBottom:3}}>
                            {p.name}
                          </button>
                      ))}
                      {customPresets.length>0&&(<>
                        <div style={{fontSize:9,color:"#475569",fontFamily:"monospace",margin:"10px 0 6px"}}>SAVED</div>
                        {customPresets.map((p,i)=>(
                            <div key={i} style={{display:"flex",gap:4,marginBottom:3}}>
                              <button onClick={()=>{setTable(p.polygon);setShowPresets(false);}}
                                      onMouseEnter={e=>e.currentTarget.style.background="#334155"}
                                      onMouseLeave={e=>e.currentTarget.style.background="#1e293b"}
                                      style={{flex:1,background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace",cursor:"pointer",textAlign:"left"}}>{p.name}</button>
                              <button onClick={()=>saveCustomPresets(customPresets.filter((_,j)=>j!==i))} style={{background:"transparent",border:"1px solid #334155",borderRadius:4,padding:"4px 7px",color:"#ef4444",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>×</button>
                            </div>
                        ))}
                      </>)}
                      <div style={{borderTop:"1px solid #1e293b",marginTop:10,paddingTop:10}}>
                        <div style={{fontSize:9,color:"#475569",fontFamily:"monospace",marginBottom:6}}>SAVE CURRENT TABLE</div>
                        <div style={{display:"flex",gap:5}}>
                          <input value={presetNameInput} onChange={e=>setPresetNameInput(e.target.value)}
                                 onKeyDown={e=>{if(e.key==="Enter"&&presetNameInput.trim()){saveCustomPresets([...customPresets,{name:presetNameInput.trim(),polygon:table}]);setPresetNameInput("");}if(e.key==="Escape")setShowPresets(false);}}
                                 placeholder="Preset name…"
                                 style={{flex:1,background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"5px 8px",color:"#f1f5f9",fontFamily:"monospace",fontSize:11}}/>
                          <button onClick={()=>{if(presetNameInput.trim()){saveCustomPresets([...customPresets,{name:presetNameInput.trim(),polygon:table}]);setPresetNameInput("");}}} style={{background:"#1d4ed8",border:"none",borderRadius:4,padding:"5px 10px",color:"#fff",fontFamily:"monospace",fontSize:11,cursor:"pointer"}}>Save</button>
                        </div>
                      </div>
                    </div>
                )}
              </div>
          )}

          {/* Side chips */}
          {!tMode&&table.length>=3&&(
              <div style={{display:"flex",gap:3,alignItems:"center"}}>
                <span style={{fontSize:9,color:"#475569"}}>SIDES:</span>
                {table.map((pt,i)=>{
                  const next=table[(i+1)%table.length];
                  const len=Math.hypot(next[0]-pt[0],next[1]-pt[1]);
                  return <button key={i} onClick={()=>setEditSide({idx:i,value:len.toFixed(1)})} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 6px",color:"#fbbf24",fontSize:10,fontFamily:"monospace",cursor:"pointer"}}>{len.toFixed(0)}"</button>;
                })}
              </div>
          )}

          <label style={{background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"4px 10px",color:"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>
            Load <input type="file" accept=".sct" onChange={loadFile} style={{display:"none"}}/>
          </label>

          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
            {/* Status */}
            <div style={{fontSize:11,padding:"3px 10px",borderRadius:4,
              background:!markerPlaced?"#1e293b":allClosed?"rgba(34,197,94,0.15)":"rgba(251,191,36,0.1)",
              border:`1px solid ${!markerPlaced?"#334155":allClosed?"#22c55e":"#fbbf24"}`,
              color:!markerPlaced?"#475569":allClosed?"#22c55e":"#fbbf24"}}>
              {!markerPlaced?"No start marker":allClosed?`✓ All ${chains.length} closed`:
                  chains.map((c,i)=>{
                    if(!c.pieces.length) return null;
                    const o=chainOrigin(marker,i);
                    const cl=isClosed(buildConnectors(c.pieces,o));
                    return cl?null:`C${i+1}:${c.pieces.length}p`;
                  }).filter(Boolean).join(" ")||`${chains.reduce((s,c)=>s+c.pieces.length,0)} pieces`}
            </div>
            {/* Zoom + Home */}
            <div style={{display:"flex",gap:3,alignItems:"center"}}>
              <Btn onClick={()=>{
                const c=canvasRef.current; if(!c)return;
                const cx=c.width/2, cy=c.height/2;
                setVp(v=>{const nz=Math.max(0.2,v.zoom/1.2);const wx=(cx-v.px)/(SCALE*v.zoom);const wy=(cy-v.py)/(SCALE*v.zoom);return{zoom:nz,px:cx-wx*SCALE*nz,py:cy-wy*SCALE*nz};});
              }}>−</Btn>
              <span style={{fontSize:10,color:"#475569",minWidth:36,textAlign:"center"}}>{Math.round(vp.zoom*100)}%</span>
              <Btn onClick={()=>{
                const c=canvasRef.current; if(!c)return;
                const cx=c.width/2, cy=c.height/2;
                setVp(v=>{const nz=Math.min(5,v.zoom*1.2);const wx=(cx-v.px)/(SCALE*v.zoom);const wy=(cy-v.py)/(SCALE*v.zoom);return{zoom:nz,px:cx-wx*SCALE*nz,py:cy-wy*SCALE*nz};});
              }}>+</Btn>
              <Btn title="Reset view to fit table" onClick={()=>{
                const c=canvasRef.current; if(!c) return;
                // Fit the table polygon (or marker) into view with padding
                const pts = table.length >= 3 ? table : markerPlaced ? [[marker.x,marker.y]] : [[0,0]];
                const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
                const minX=Math.min(...xs), maxX=Math.max(...xs);
                const minY=Math.min(...ys), maxY=Math.max(...ys);
                const padX=12, padY=12;
                const worldW = Math.max(maxX-minX, 12), worldH = Math.max(maxY-minY, 12);
                const fitZoom = Math.min(5, Math.max(0.2,
                    Math.min((c.width-padX*2)/(SCALE*worldW), (c.height-padY*2)/(SCALE*worldH))
                ));
                const centerWX=(minX+maxX)/2, centerWY=(minY+maxY)/2;
                setVp({zoom:fitZoom, px:c.width/2-centerWX*SCALE*fitZoom, py:c.height/2-centerWY*SCALE*fitZoom});
              }}>⌂</Btn>
            </div>
          </div>
        </div>

        {/* ── Main ── */}
        <div style={{display:"flex",flex:1,overflow:"hidden"}}>
          <Palette onAdd={addPiece} filter={filter} setFilter={setFilter}/>

          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}
                 style={{flex:1,position:"relative",overflow:"hidden",
                   cursor:tMode?"crosshair":placingMarker?"crosshair":draggingMarker?"grabbing":markerPlaced&&!panning?"default":"default"}}>
              <canvas ref={canvasRef} style={{display:"block",width:"100%",height:"100%"}}/>

              <div style={{position:"absolute",bottom:8,right:8,fontSize:9,color:"#334155",fontFamily:"monospace"}}>
                Drag start marker to reposition · Alt+drag or middle-click to pan · Scroll to zoom
              </div>

              {/* No start marker prompt */}
              {!markerPlaced&&!placingMarker&&!tMode&&(
                  <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",textAlign:"center",pointerEvents:"none"}}>
                    <div style={{fontSize:13,color:"#475569",fontFamily:"monospace",marginBottom:8}}>Click "📍 Place Start" to begin</div>
                    <div style={{fontSize:10,color:"#334155",fontFamily:"monospace"}}>The start marker sets where all chains begin</div>
                  </div>
              )}

              {/* Pending segment length input */}
              {pendSeg&&(
                  <div onMouseDown={e=>e.stopPropagation()} style={{position:"absolute",left:Math.max(8,pendSeg.sx-65),top:Math.max(8,pendSeg.sy-58),background:"#0f172a",border:"2px solid #38bdf8",borderRadius:6,padding:"6px 10px",zIndex:50,boxShadow:"0 4px 16px rgba(0,0,0,0.7)"}}>
                    <div style={{fontSize:9,color:"#38bdf8",fontFamily:"monospace",marginBottom:4}}>SET LENGTH (inches)</div>
                    <input ref={pendingRef} value={pendSeg.value}
                           onChange={e=>setPendSeg(s=>({...s,value:e.target.value}))}
                           onKeyDown={e=>{
                             if(e.key==="Enter"){const nd=applyLen(draft,pendSeg,pendSeg.value);setDraft(nd);setPendSeg(null);}
                             if(e.key==="Escape")setPendSeg(null);
                           }}
                           style={{width:100,background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"4px 7px",color:"#f1f5f9",fontFamily:"monospace",fontSize:13}}/>
                    <div style={{fontSize:8,color:"#475569",fontFamily:"monospace",marginTop:4}}>Enter to set · Esc or next click to skip</div>
                  </div>
              )}


              {/* Add / Replace / Remove piece popup */}
              {selectedPiece && !tMode && !placingMarker && (() => {
                const chain = chains[selectedPiece.chainIdx];
                const piece = chain?.pieces[selectedPiece.pieceIdx];
                if (!piece) return null;
                const color = CHAIN_COLORS[selectedPiece.chainIdx % CHAIN_COLORS.length];
                const popLeft = Math.min(Math.max(8, selectedPiece.screenX - 125), window.innerWidth - 310);
                const popTop = Math.max(8, selectedPiece.screenY - 240);
                const types = ["straight","curve","ramp"];
                const filtered = PIECES.filter(p =>
                    popupMode === "replace"
                        ? p.id !== piece.id && (!popupTypeFilter || p.type === popupTypeFilter)
                        : !popupTypeFilter || p.type === popupTypeFilter
                );
                const applyPiece = (p) => {
                  setChains(prev => prev.map((c,ci) => {
                    if (ci !== selectedPiece.chainIdx) return c;
                    const pieces = [...c.pieces];
                    if (popupMode === "replace") {
                      pieces[selectedPiece.pieceIdx] = p;
                    } else {
                      pieces.splice(selectedPiece.pieceIdx + 1, 0, p);
                    }
                    return {...c, pieces};
                  }));
                  setSelectedPiece(null);
                };
                return (
                    <div onMouseDown={e => e.stopPropagation()}
                         style={{position:"absolute",left:popLeft,top:popTop,background:"#0f172a",border:`2px solid ${color}`,borderRadius:8,padding:12,zIndex:60,width:260,boxShadow:"0 8px 32px rgba(0,0,0,0.75)"}}>
                      {/* Header */}
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <div style={{fontSize:11,color:color,fontFamily:"monospace",fontWeight:"bold"}}>
                          #{selectedPiece.pieceIdx+1} — {piece.label}
                        </div>
                        <button onClick={()=>setSelectedPiece(null)} style={{background:"transparent",border:"none",color:"#475569",fontSize:14,cursor:"pointer",padding:"0 2px"}}>×</button>
                      </div>
                      {/* Mode toggle */}
                      <div style={{display:"flex",gap:4,marginBottom:10}}>
                        {["replace","add"].map(mode => (
                            <button key={mode} onClick={()=>setPopupMode(mode)} style={{
                              flex:1, padding:"4px 0", borderRadius:4, fontSize:11, fontFamily:"monospace",
                              cursor:"pointer", border:`1px solid ${popupMode===mode?color:"#334155"}`,
                              background: popupMode===mode?`${color}22`:"#1e293b",
                              color: popupMode===mode?color:"#64748b",
                              fontWeight: popupMode===mode?"bold":"normal",
                            }}>
                              {mode === "replace" ? "⇄ Replace" : "+ Add After"}
                            </button>
                        ))}
                      </div>
                      {/* Type filter tabs */}
                      <div style={{display:"flex",gap:3,marginBottom:8}}>
                        <button onClick={()=>setPopupTypeFilter(null)} style={{
                          flex:1,padding:"3px 0",borderRadius:3,fontSize:9,fontFamily:"monospace",cursor:"pointer",
                          border:`1px solid ${!popupTypeFilter?"#94a3b8":"#334155"}`,
                          background:!popupTypeFilter?"#334155":"#1e293b",color:!popupTypeFilter?"#f1f5f9":"#64748b"
                        }}>all</button>
                        {types.map(t => (
                            <button key={t} onClick={()=>setPopupTypeFilter(t)} style={{
                              flex:1,padding:"3px 0",borderRadius:3,fontSize:9,fontFamily:"monospace",cursor:"pointer",
                              border:`1px solid ${popupTypeFilter===t?"#94a3b8":"#334155"}`,
                              background:popupTypeFilter===t?"#334155":"#1e293b",
                              color:popupTypeFilter===t?"#f1f5f9":"#64748b"
                            }}>{t}</button>
                        ))}
                      </div>
                      {/* Piece list */}
                      <div style={{display:"flex",flexDirection:"column",gap:2,maxHeight:180,overflowY:"auto",marginBottom:8}}>
                        {filtered.length === 0 && (
                            <div style={{fontSize:10,color:"#475569",fontFamily:"monospace",padding:"4px 0"}}>No other pieces of this type</div>
                        )}
                        {filtered.map(p => (
                            <button key={p.id} onClick={()=>applyPiece(p)}
                                    onMouseEnter={e=>e.currentTarget.style.background="#334155"}
                                    onMouseLeave={e=>e.currentTarget.style.background="#1e293b"}
                                    style={{background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"5px 8px",
                                      color:"#e2e8f0",fontSize:11,fontFamily:"monospace",cursor:"pointer",textAlign:"left",
                                      display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span>{p.label}</span>
                              {p.type !== piece.type && <span style={{fontSize:9,color:"#475569"}}>{p.type}</span>}
                            </button>
                        ))}
                      </div>
                      {/* Remove — only shown in replace mode */}
                      {popupMode === "replace" && (
                          <button
                              onClick={() => {
                                setChains(prev => prev.map((c,ci) => ci !== selectedPiece.chainIdx ? c : {
                                  ...c, pieces: c.pieces.filter((_,pi) => pi !== selectedPiece.pieceIdx)
                                }));
                                setSelectedPiece(null);
                              }}
                              onMouseEnter={e=>e.currentTarget.style.background="rgba(239,68,68,0.15)"}
                              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                              style={{width:"100%",background:"transparent",border:"1px solid #ef4444",borderRadius:4,
                                padding:"5px 8px",color:"#ef4444",fontSize:11,fontFamily:"monospace",cursor:"pointer",textAlign:"left"}}>
                            🗑 Remove this piece
                          </button>
                      )}
                    </div>
                );
              })()}
              {/* Quick pick */}
              {showQP&&(
                  <div style={{position:"absolute",bottom:52,left:"50%",transform:"translateX(-50%)"}}>
                    <QuickPick onSelect={addPiece} onClose={()=>setShowQP(false)} lastPiece={activePieces[activePieces.length-1]}/>
                  </div>
              )}

              {/* Add/Undo */}
              {!tMode&&!placingMarker&&markerPlaced&&(
                  <div style={{position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",display:"flex",gap:6,alignItems:"center"}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:activeColor,boxShadow:`0 0 8px ${activeColor}`}}/>
                    <span style={{fontSize:10,color:activeColor,fontFamily:"monospace"}}>{chains[activeChain]?.label}</span>
                    <button onClick={()=>setShowQP(v=>!v)} style={{background:"#1d4ed8",border:"none",borderRadius:6,color:"#fff",fontSize:12,fontFamily:"monospace",padding:"7px 16px",cursor:"pointer",boxShadow:"0 4px 12px rgba(29,78,216,0.5)"}}>+ Add Piece</button>
                    {activePieces.length>0&&<button onClick={undoLast} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:12,fontFamily:"monospace",padding:"7px 12px",cursor:"pointer"}}>↩ Undo</button>}
                  </div>
              )}

              {/* Table drawing done/undo */}
              {tMode&&draft.length>=3&&!pendSeg&&(
                  <div onMouseDown={e=>e.stopPropagation()} style={{position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",display:"flex",gap:6}}>
                    <button onClick={()=>finishDraft()} style={{background:"#15803d",border:"none",borderRadius:6,color:"#fff",fontSize:12,fontFamily:"monospace",padding:"7px 16px",cursor:"pointer",boxShadow:"0 4px 12px rgba(21,128,61,0.5)"}}>✓ Done ({draft.length} corners)</button>
                    <button onClick={()=>setDraft(d=>d.slice(0,-1))} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:12,fontFamily:"monospace",padding:"7px 12px",cursor:"pointer"}}>↩ Undo Point</button>
                  </div>
              )}
            </div>

            {/* ── Bottom panel ── */}
            <div style={{borderTop:"1px solid #1e293b",background:"#020617",padding:"8px 12px",flexShrink:0}}>
              {markerPlaced&&laneData.length>0&&(
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:10,color:"#475569",fontFamily:"monospace",marginBottom:4}}>LANE LENGTHS</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
                      {laneData.map(({chainIdx,l1,l2})=>{
                        const color=CHAIN_COLORS[chainIdx%CHAIN_COLORS.length];
                        const delta=Math.abs(l1-l2);
                        return (
                            <div key={chainIdx} style={{display:"flex",gap:8,alignItems:"center"}}>
                              <span style={{fontSize:10,color,fontFamily:"monospace",fontWeight:"bold"}}>C{chainIdx+1}</span>
                              <span style={{fontSize:11,fontFamily:"monospace"}}>
                          <span style={{color:color}}>L1</span>
                          <span style={{color:"#f1f5f9",marginLeft:4}}>{l1.toFixed(1)}"</span>
                        </span>
                              <span style={{fontSize:11,fontFamily:"monospace"}}>
                          <span style={{color:color+"aa"}}>L2</span>
                          <span style={{color:"#f1f5f9",marginLeft:4}}>{l2.toFixed(1)}"</span>
                        </span>
                              <span style={{fontSize:10,fontFamily:"monospace",color:delta>3?"#ef4444":delta>1?"#f59e0b":"#22c55e"}}>Δ{delta.toFixed(1)}"</span>
                            </div>
                        );
                      })}
                    </div>
                  </div>
              )}

              {chains.some(c=>c.pieces.length>0)&&(
                  <div>
                    <div style={{fontSize:10,color:"#475569",fontFamily:"monospace",marginBottom:4}}>BILL OF MATERIALS</div>
                    <BOM chains={chains}/>
                  </div>
              )}
            </div>
          </div>
        </div>

        {/* Side length editor */}
        {editSide&&(
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
              <div style={{background:"#0f172a",border:"1px solid #334155",borderRadius:8,padding:20,minWidth:260,boxShadow:"0 8px 32px rgba(0,0,0,0.7)"}}>
                <div style={{fontSize:11,color:"#64748b",fontFamily:"monospace",marginBottom:8}}>EDIT SIDE {editSide.idx+1} LENGTH (inches)</div>
                <input autoFocus value={editSide.value} onChange={e=>setEditSide(s=>({...s,value:e.target.value}))}
                       onKeyDown={e=>{
                         if(e.key==="Enter"){
                           const len=parseFloat(editSide.value);
                           if(!isNaN(len)&&len>0){
                             setTable(prev=>{
                               const pts=prev.map(p=>[...p]);
                               const a=pts[editSide.idx],bIdx=(editSide.idx+1)%pts.length,b=pts[bIdx];
                               const dx=b[0]-a[0],dy=b[1]-a[1],cur=Math.hypot(dx,dy);
                               if(cur>0.001){const sc=len/cur;pts[bIdx]=[+(a[0]+dx*sc).toFixed(2),+(a[1]+dy*sc).toFixed(2)];}
                               return pts;
                             });
                           }
                           setEditSide(null);
                         }
                         if(e.key==="Escape")setEditSide(null);
                       }}
                       style={{width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"8px",color:"#f1f5f9",fontFamily:"monospace",fontSize:14,boxSizing:"border-box"}}/>
                <div style={{fontSize:9,color:"#475569",fontFamily:"monospace",marginTop:6}}>Enter to apply · Escape to cancel</div>
              </div>
            </div>
        )}
      </div>
  );
}
