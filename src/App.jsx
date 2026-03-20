import { useState, useRef, useEffect, useCallback } from "react";
import { PIECES } from './pieces/aurora.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const SCALE = 18;
const TRACK_WIDTH = 3.0;
const LOOP_TOL = 0.15;
const SNAP_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const SNAP_THRESH = 10;

const TRACK_COLORS = ["#f59e0b","#38bdf8","#a78bfa","#34d399","#fb7185","#fb923c","#e879f9","#4ade80"];
const SLOT_OFFSET = [0.75, 2.25]; // inches from outside edge
const ELEV_STRIPE = "#a3e635";

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
  const dx = wx - entry.x, dy = wy - entry.y;
  const along = dx * Math.cos(ar) + dy * Math.sin(ar);
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

// Find which piece (if any) was clicked. Returns {trackIdx, pieceIdx} or null.
function hitTestPieces(wx, wy, tracks, marker) {
  const order = [...tracks.keys()];
  for (const ci of order) {
    const origin = trackOrigin(marker, ci);
    const conns = buildConnectors(tracks[ci].pieces, origin);
    for (let pi = conns.length - 1; pi >= 0; pi--) {
      const {entry, exit, piece} = conns[pi];
      let hit = false;
      if (piece.type === "straight" || piece.type === "ramp") {
        hit = hitStraight(wx, wy, entry, exit, entry.angleDeg);
      } else if (piece.type === "curve") {
        hit = hitCurve(wx, wy, entry, piece);
      }
      if (hit) return {trackIdx: ci, pieceIdx: pi};
    }
  }
  return null;
}

// ─── Track Origin ─────────────────────────────────────────────────────────────
function trackOrigin(marker, trackIdx) {
  const ar = d2r(marker.angleDeg);
  const perpX = -Math.sin(ar), perpY = Math.cos(ar);
  return {
    x: marker.x + perpX * trackIdx * TRACK_WIDTH,
    y: marker.y + perpY * trackIdx * TRACK_WIDTH,
    angleDeg: marker.angleDeg,
    elevIn: 0,
  };
}

function allLaneLengths(tracks) {
  const result = [];
  tracks.forEach((track, ci) => {
    let l1 = 0, l2 = 0;
    for (const p of track.pieces) {
      if (p.type === "straight" || p.type === "ramp") { l1 += p.length_in; l2 += p.length_in; }
      else if (p.type === "curve") {
        const rad = d2r(p.a);
        if (p.turn === "R") {
          l1 += Math.max(0, p.r - 0.75) * rad;
          l2 += Math.max(0, p.r - 2.25) * rad;
        } else {
          l1 += Math.max(0, p.r - 2.25) * rad;
          l2 += Math.max(0, p.r - 0.75) * rad;
        }
      }
    }
    result.push({trackIdx: ci, l1, l2});
  });
  return result;
}

// ─── Canvas Draw ──────────────────────────────────────────────────────────────
function drawCanvas(canvas, tracks, marker, markerPlaced, table, vp, activeTrack, selectedPiece) {
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

  // Draw each track
  tracks.forEach((track, ci) => {
    if (!markerPlaced) return;
    const origin = trackOrigin(marker, ci);
    const conns = buildConnectors(track.pieces, origin);
    const closed = isClosed(conns);
    const color = TRACK_COLORS[ci % TRACK_COLORS.length];
    const isActive = ci === activeTrack;
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
        if (entry.elevIn > 0 && piece.type !== "ramp") {
          ctx.beginPath();
          ctx.moveTo(ex+px*hw, ey+py*hw);
          ctx.lineTo(xx+px*hw, xy+py*hw);
          ctx.strokeStyle = ELEV_STRIPE;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
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
        if (entry.elevIn > 0) {
          ctx.beginPath();
          ctx.arc(scx, scy, outerR, startA, endA, acw);
          ctx.strokeStyle = ELEV_STRIPE;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
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
    if (selectedPiece && selectedPiece.trackIdx === ci) {
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
          const ts2=piece.turn==="L"?-1:1;
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

    ctx.restore();
  });

  // Start marker
  if (markerPlaced) {
    const {sx,sy} = ts(marker.x,marker.y);
    const ar = d2r(marker.angleDeg);
    ctx.save();
    // Draw parallel track start lines
    tracks.forEach((_, ci) => {
      const orig = trackOrigin(marker, ci);
      const {sx:ox2,sy:oy2} = ts(orig.x,orig.y);
      const color = TRACK_COLORS[ci % TRACK_COLORS.length];
      const perpX=-Math.sin(ar), perpY=Math.cos(ar);
      const hw=sc(TRACK_WIDTH/2);
      // start line for this track
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

// ─── Help Menu ────────────────────────────────────────────────────────────────
function HelpMenu({onClose}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleClose = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem("sct-hide-help", "true");
      } catch {
        // localStorage may not be available in some contexts
      }
    }
    onClose();
  };

  return (
    <div onClick={handleClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,backdropFilter:"blur(2px)"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#0f172a",border:"2px solid #38bdf8",borderRadius:12,padding:"24px",maxWidth:680,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 12px 48px rgba(0,0,0,0.9)"}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:20,fontWeight:"bold",color:"#38bdf8",fontFamily:"monospace"}}>TRACK BUILDER HELP</span>
          </div>
          <button onClick={handleClose} style={{background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#94a3b8",fontSize:20,cursor:"pointer",padding:"2px 8px",lineHeight:1}}>×</button>
        </div>

        {/* Keybinds */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:14,color:"#38bdf8",fontFamily:"monospace",fontWeight:"bold",marginBottom:10,borderBottom:"1px solid #1e293b",paddingBottom:4}}>KEYBOARD SHORTCUTS</div>
          <div style={{display:"grid",gridTemplateColumns:"140px 1fr",gap:"10px 16px",fontSize:13,fontFamily:"monospace"}}>
            <span style={{color:"#fbbf24",fontWeight:"bold"}}>Escape</span>
            <span style={{color:"#e2e8f0"}}>Cancel table drawing / Close popups</span>
            <span style={{color:"#fbbf24",fontWeight:"bold"}}>Enter</span>
            <span style={{color:"#e2e8f0"}}>Confirm length input in table mode</span>
            <span style={{color:"#fbbf24",fontWeight:"bold"}}>Backspace</span>
            <span style={{color:"#e2e8f0"}}>Undo last point in table drawing</span>
            <span style={{color:"#fbbf24",fontWeight:"bold"}}>Scroll Wheel</span>
            <span style={{color:"#e2e8f0"}}>Zoom in/out on canvas</span>
            <span style={{color:"#fbbf24",fontWeight:"bold"}}>Alt + Drag</span>
            <span style={{color:"#e2e8f0"}}>Pan canvas (or use middle-click)</span>
          </div>
        </div>

        {/* Key Buttons */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:14,color:"#38bdf8",fontFamily:"monospace",fontWeight:"bold",marginBottom:10,borderBottom:"1px solid #1e293b",paddingBottom:4}}>KEY BUTTONS</div>
          <div style={{display:"flex",flexDirection:"column",gap:10,fontSize:13,fontFamily:"monospace"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{color:"#22c55e",fontSize:18}}>→</span>
              <span style={{color:"#94a3b8",background:"#1e293b",padding:"4px 10px",borderRadius:3,border:"1px solid #334155"}}>Load Saved Track</span>
              <span style={{color:"#e2e8f0"}}>Load track layouts from .sct files</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{color:"#22c55e",fontSize:18}}>→</span>
              <span style={{color:"#94a3b8",background:"#1e293b",padding:"4px 10px",borderRadius:3,border:"1px solid #334155"}}>Save Track</span>
              <span style={{color:"#e2e8f0"}}>Save your layout to a .sct file</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{color:"#22c55e",fontSize:18}}>→</span>
              <span style={{color:"#94a3b8",background:"#1e293b",padding:"4px 10px",borderRadius:3,border:"1px solid #334155"}}>BOM CSV</span>
              <span style={{color:"#e2e8f0"}}>Export bill of materials as CSV</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{color:"#22c55e",fontSize:18}}>→</span>
              <span style={{color:"#94a3b8",background:"#1e293b",padding:"4px 10px",borderRadius:3,border:"1px solid #334155"}}>Draw Table</span>
              <span style={{color:"#e2e8f0"}}>Define table boundary polygon</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{color:"#22c55e",fontSize:18}}>←</span>
              <span style={{color:"#94a3b8",background:"#1e293b",padding:"4px 10px",borderRadius:3,border:"1px solid #334155"}}>Sidebar</span>
              <span style={{color:"#e2e8f0"}}>Click pieces to add to track</span>
            </div>
          </div>
        </div>

        {/* Features */}
        <div style={{marginBottom:20}}>
          <div style={{fontSize:14,color:"#38bdf8",fontFamily:"monospace",fontWeight:"bold",marginBottom:10,borderBottom:"1px solid #1e293b",paddingBottom:4}}>FEATURES</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,fontSize:13,fontFamily:"monospace",color:"#e2e8f0"}}>
            <div style={{display:"flex",gap:10}}>
              <span style={{color:"#22c55e"}}>•</span>
              <span><strong style={{color:"#fbbf24"}}>Click canvas</strong> to place start marker (first time)</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{color:"#22c55e"}}>•</span>
              <span><strong style={{color:"#fbbf24"}}>Drag start marker</strong> to reposition after placement</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{color:"#22c55e"}}>•</span>
              <span><strong style={{color:"#fbbf24"}}>Click any piece</strong> to replace, add after, or remove it</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{color:"#22c55e"}}>•</span>
              <span><strong style={{color:"#fbbf24"}}>Save/Load tracks</strong> as .sct files for later use</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{color:"#22c55e"}}>•</span>
              <span><strong style={{color:"#fbbf24"}}>Export BOM</strong> as CSV for ordering parts</span>
            </div>
            <div style={{display:"flex",gap:10}}>
              <span style={{color:"#22c55e"}}>•</span>
              <span><strong style={{color:"#fbbf24"}}>Multiple tracks</strong> supported with independent lanes</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{borderTop:"1px solid #1e293b",paddingTop:16}}>
          <div style={{fontSize:12,color:"#64748b",fontFamily:"monospace",marginBottom:12,textAlign:"center"}}>
            You can reopen this help menu anytime by clicking the <strong style={{color:"#94a3b8"}}>Help</strong> button in the top-right corner of the toolbar.
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,fontFamily:"monospace",color:"#94a3b8",cursor:"pointer"}}>
              <input type="checkbox" checked={dontShowAgain} onChange={e=>setDontShowAgain(e.target.checked)} style={{cursor:"pointer"}}/>
              Don't show this again
            </label>
            <button onClick={handleClose} style={{background:"#1d4ed8",border:"none",borderRadius:6,padding:"8px 20px",color:"#fff",fontSize:12,fontFamily:"monospace",fontWeight:"bold",cursor:"pointer"}}>Got it!</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── BOM ──────────────────────────────────────────────────────────────────────
function BOM({tracks}) {
  const c={};
  for(const track of tracks) {
    for(const p of track.pieces){
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


// ─── Palette ──────────────────────────────────────────────────────────────────
function Palette({onAdd,filter,setFilter}) {
  const tags=["all","common","straight","curve","ramp"];
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

// ─── Button Component ─────────────────────────────────────────────────────────
const Btn=({children,onClick,active,color,disabled,title})=>(
    <button title={title} onClick={onClick} disabled={disabled} style={{background:active?(color?`rgba(${color},0.15)`:"rgba(29,78,216,0.2)"):"#1e293b",border:`1px solid ${active?(color?`rgb(${color})`:"#3b82f6"):"#334155"}`,borderRadius:4,padding:"4px 10px",color:disabled?"#334155":active?(color?`rgb(${color})`:"#60a5fa"):"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:disabled?"default":"pointer"}}>{children}</button>
);

// ─── App ──────────────────────────────────────────────────────────────────────
const mkTrack = (idx) => ({id: idx, label: `Track ${idx+1}`, pieces: []});

export default function App() {
  const canvasRef = useRef(null);
  const pendingRef = useRef(null);
  const prevSegIdx = useRef(null);

  // ── Layout state ──────────────────────────────────────────────────────────
  const [tracks, setTracks] = useState([mkTrack(0)]);
  const [activeTrack, setActiveTrack] = useState(0);
  const [marker, setMarker] = useState({x:20, y:15, angleDeg:0});
  const [markerPlaced, setMarkerPlaced] = useState(false);
  const [draggingMarker, setDraggingMarker] = useState(false);

  const [table, setTable] = useState([[0,0],[108,0],[108,60],[0,60]]);
  const [filter, setFilter] = useState("common");
  const [layoutName, setLayoutName] = useState("My Layout");

  // ── Viewport ──────────────────────────────────────────────────────────────
  const [vp, setVp] = useState({zoom:1, px:40, py:40});
  const [panning, setPanning] = useState(false);
  const [panStart, setPanStart] = useState(null);

  // ── Table drawing ─────────────────────────────────────────────────────────
  const [tMode, setTMode] = useState(false);
  const [draft, setDraft] = useState([]);
  const [mPos, setMPos] = useState(null);
  const [snapPt, setSnapPt] = useState(null);
  const [isSnapped, setIsSnapped] = useState(false);
  const [snapAng, setSnapAng] = useState(null);
  const [pendSeg, setPendSeg] = useState(null);
  const [editSide, setEditSide] = useState(null);
  const [selectedPiece, setSelectedPiece] = useState(null);
  const [popupMode, setPopupMode] = useState("replace");
  const [popupTypeFilter, setPopupTypeFilter] = useState(null);
  const [showHelp, setShowHelp] = useState(() => {
    try {
      return localStorage.getItem("sct-hide-help") !== "true";
    } catch {
      // localStorage may not be available in some contexts
      return true;
    }
  });

  // ── Presets ───────────────────────────────────────────────────────────────
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
    try{localStorage.setItem("sct-table-presets",JSON.stringify(p));}catch{
      // localStorage may not be available
    }
  };
  const [showPresets, setShowPresets] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState("");

  const fitToView = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const pts = table.length >= 3 ? table : markerPlaced ? [[marker.x, marker.y]] : [[0, 0]];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const worldW = Math.max(maxX - minX, 12), worldH = Math.max(maxY - minY, 12);
    const fitZoom = Math.min(5, Math.max(0.2, Math.min((c.width - 24) / (SCALE * worldW), (c.height - 24) / (SCALE * worldH))));
    setVp({
      zoom: fitZoom,
      px: c.width / 2 - ((minX + maxX) / 2) * SCALE * fitZoom,
      py: c.height / 2 - ((minY + maxY) / 2) * SCALE * fitZoom
    });
  }, [table, markerPlaced, marker]);

  // ── Initial fit ──
  useEffect(() => {
    const timer = setTimeout(fitToView, 50); // Small delay to ensure canvas has dimensions
    return () => clearTimeout(timer);
  }, [fitToView]);

  // ── Helpers ───────────────────────────────────────────────────────────────
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

  const nearMarker = useCallback((wx,wy)=>{
    if(!markerPlaced) return false;
    return Math.hypot(wx-marker.x, wy-marker.y) < 1.2;
  },[markerPlaced,marker]);

  // ── Resize ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const resize=()=>{const c=canvasRef.current;if(!c)return;c.width=c.parentElement.clientWidth;c.height=c.parentElement.clientHeight;};
    resize(); window.addEventListener("resize",resize); return()=>window.removeEventListener("resize",resize);
  },[]);

  // ── Render ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const canvas=canvasRef.current; if(!canvas) return;
    drawCanvas(canvas,tracks,marker,markerPlaced,table,vp,activeTrack,selectedPiece);

    if(!tMode) return;
    const ctx=canvas.getContext("2d");
    const toS=(wx,wy)=>({sx:wx*SCALE*vp.zoom+vp.px,sy:wy*SCALE*vp.zoom+vp.py});

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
  },[tracks,marker,markerPlaced,table,vp,activeTrack,selectedPiece,tMode,draft,mPos,snapPt,isSnapped,snapAng,pendSeg,w2s]);

  // ── Focus pending input ───────────────────────────────────────────────────
  useEffect(()=>{
    const curIdx=pendSeg?pendSeg.si:null;
    if(curIdx!==null&&curIdx!==prevSegIdx.current&&pendingRef.current){
      pendingRef.current.focus(); pendingRef.current.select();
    }
    prevSegIdx.current=curIdx;
  },[pendSeg]);

  // ── Track actions ─────────────────────────────────────────────────────────
  const addPiece = useCallback(p=>{
    setTracks(prev=>prev.map((c,i)=>i===activeTrack?{...c,pieces:[...c.pieces,p]}:c));
  },[activeTrack]);

  const undoLast = ()=>{
    setTracks(prev=>prev.map((c,i)=>i===activeTrack?{...c,pieces:c.pieces.slice(0,-1)}:c));
  };

  const addTrack = ()=>{
    const idx=tracks.length;
    setTracks(prev=>[...prev,mkTrack(idx)]);
    setActiveTrack(idx);
  };

  const removeTrack = (idx)=>{
    const track=tracks[idx];
    if(track.pieces.length>0){
      if(!window.confirm(`Track ${idx+1} has ${track.pieces.length} piece(s). Remove it anyway?`)) return;
    }
    const newTracks=tracks.filter((_,i)=>i!==idx).map((c,i)=>({...c,id:i,label:`Track ${i+1}`}));
    if(!newTracks.length) { setTracks([mkTrack(0)]); setActiveTrack(0); return; }
    setTracks(newTracks);
    setActiveTrack(Math.min(activeTrack,newTracks.length-1));
  };

  const clearAll = ()=>{
    setTracks([mkTrack(0)]); setActiveTrack(0);
    setMarkerPlaced(false);
  };

  // ── Table drawing ─────────────────────────────────────────────────────────
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

  // ── Keyboard ──────────────────────────────────────────────────────────────
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

  // ── Mouse ─────────────────────────────────────────────────────────────────
  const onDown=e=>{
    // Table drawing mode
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

    if(e.button===0&&!e.altKey){
      const rect=canvasRef.current.getBoundingClientRect();
      const w=s2w(e.clientX-rect.left,e.clientY-rect.top);

      // First-time placement: clicking anywhere drops the marker
      if(!markerPlaced){
        setMarker(m=>({...m,x:w.x,y:w.y}));
        setMarkerPlaced(true);
        return;
      }

      // Marker drag takes priority over piece selection
      if(nearMarker(w.x,w.y)){
        setDraggingMarker(true);
        return;
      }

      // Hit test pieces
      const hit=hitTestPieces(w.x,w.y,tracks,marker);
      if(hit){
        const conns=buildConnectors(tracks[hit.trackIdx].pieces,trackOrigin(marker,hit.trackIdx));
        const midWorld={x:(conns[hit.pieceIdx].entry.x+conns[hit.pieceIdx].exit.x)/2,y:(conns[hit.pieceIdx].entry.y+conns[hit.pieceIdx].exit.y)/2};
        const midScreen=w2s(midWorld.x,midWorld.y);
        const hitPiece = tracks[hit.trackIdx]?.pieces[hit.pieceIdx];
        setSelectedPiece({...hit,screenX:midScreen.sx,screenY:midScreen.sy});
        setPopupMode("replace");
        setPopupTypeFilter(hitPiece?.type || null);
        setActiveTrack(hit.trackIdx);
        return;
      }

      // Click on empty canvas dismisses selection
      setSelectedPiece(null);
      return;
    }

    if(e.button===1||(e.button===0&&e.altKey)){
      setPanning(true);
      const rect=canvasRef.current?.getBoundingClientRect();
      const c=canvasRef.current;
      const sX=c?c.width/c.offsetWidth:1, sY=c?c.height/c.offsetHeight:1;
      const csx=(e.clientX-rect.left)*sX, csy=(e.clientY-rect.top)*sY;
      setPanStart({x:csx-vp.px,y:csy-vp.py});
    }
  };

  const onMove=e=>{
    const rect=canvasRef.current?.getBoundingClientRect();
    if(!rect) return;
    const sx=e.clientX-rect.left,sy=e.clientY-rect.top;
    if(tMode) setMPos({sx,sy});
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
      const c=canvasRef.current;
      const sX=c?c.width/c.offsetWidth:1, sY=c?c.height/c.offsetHeight:1;
      const csx=(e.clientX-rect.left)*sX, csy=(e.clientY-rect.top)*sY;
      setVp(v=>({...v,px:csx-panStart.x,py:csy-panStart.y}));
    }
  };

  const onUp=()=>{setPanning(false);setPanStart(null);setDraggingMarker(false);};

  const onWheel=e=>{
    e.preventDefault();
    const rect=canvasRef.current?.getBoundingClientRect();
    if(!rect) return;
    const c=canvasRef.current;
    const scaleX=c?c.width/c.offsetWidth:1, scaleY=c?c.height/c.offsetHeight:1;
    const mouseX=(e.clientX-rect.left)*scaleX, mouseY=(e.clientY-rect.top)*scaleY;
    const factor=e.deltaY<0?1.1:0.9;
    setVp(v=>{
      const newZoom=Math.max(0.2,Math.min(5,v.zoom*factor));
      const worldX=(mouseX-v.px)/(SCALE*v.zoom);
      const worldY=(mouseY-v.py)/(SCALE*v.zoom);
      return {zoom:newZoom, px:mouseX-worldX*SCALE*newZoom, py:mouseY-worldY*SCALE*newZoom};
    });
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const activePieces = tracks[activeTrack]?.pieces || [];
  const laneData = markerPlaced ? allLaneLengths(tracks,marker) : [];

  // ── File ops ──────────────────────────────────────────────────────────────
  const saveFile=()=>{
    const data={version:2,library:"Aurora",name:layoutName,
      table:{polygon_in:table},
      marker:{x:marker.x,y:marker.y,angleDeg:marker.angleDeg,placed:markerPlaced},
      tracks:tracks.map(c=>({id:c.id,label:c.label,pieces:c.pieces.map(p=>({id:p.id}))}))};
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
        if(d.tracks){
          setTracks(d.tracks.map((c,i)=>({id:i,label:c.label||`Track ${i+1}`,pieces:(c.pieces||[]).map(p=>PIECES.find(l=>l.id===p.id)).filter(Boolean)})));
          setActiveTrack(0);
        } else if(d.layout?.pieces){
          setTracks([{id:0,label:"Track 1",pieces:(d.layout.pieces||[]).map(p=>PIECES.find(l=>l.id===p.id)).filter(Boolean)}]);
          setActiveTrack(0);
        }
      }catch{alert("Invalid .sct file");}
    };
    r.readAsText(file);e.target.value="";
  };

  const exportBOM=()=>{
    const rows=[];
    rows.push("BILL OF MATERIALS");
    rows.push("Piece,Count");
    const c={};
    for(const track of tracks)for(const p of track.pieces){
      const id=p.id==="rd"?"ru":p.id;
      const lbl=p.id==="rd"?"Ramp (physical)":p.label;
      if(!c[id])c[id]={lbl,n:0};c[id].n++;
    }
    Object.values(c).forEach(e=>rows.push(`"${e.lbl}",${e.n}`));
    // Assembly order per track
    tracks.filter(ch=>ch.pieces.length>0).forEach(ch=>{
      rows.push("");
      rows.push(`ASSEMBLY ORDER — ${ch.label}`);
      rows.push("Step,Piece");
      ch.pieces.forEach((p,i)=>rows.push(`${i+1},"${p.label}"`));
    });
    const url=URL.createObjectURL(new Blob([rows.join("\n")],{type:"text/csv"}));
    Object.assign(document.createElement("a"),{href:url,download:`${layoutName.replace(/\s+/g,"_")}_BOM.csv`}).click();
    URL.revokeObjectURL(url);
  };

  const activeColor = TRACK_COLORS[activeTrack % TRACK_COLORS.length];

  return (
      <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#0f172a",color:"#e2e8f0",fontFamily:"monospace",overflow:"hidden"}}>

        {/* ── Toolbar ── */}
        <div style={{display:"flex",alignItems:"center",gap:7,padding:"7px 12px",background:"#020617",borderBottom:"1px solid #1e293b",flexShrink:0,flexWrap:"wrap"}}>
          <span style={{fontSize:13,fontWeight:"bold",color:"#38bdf8",marginRight:2}}>🏎 TRACK BUILDER</span>

          <label style={{background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"4px 10px",color:"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>
            Load Saved Track <input type="file" accept=".sct" onChange={loadFile} style={{display:"none"}}/>
          </label>

          <input value={layoutName} onChange={e=>setLayoutName(e.target.value)} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:4,padding:"3px 8px",color:"#f1f5f9",fontFamily:"monospace",fontSize:11,width:130}}/>

          <Btn onClick={clearAll}>New</Btn>
          <Btn onClick={saveFile}>Save Track</Btn>
          <Btn onClick={exportBOM}>BOM CSV</Btn>

          {/* Start marker — place on first click, drag to reposition thereafter */}
          {!markerPlaced ? (
              <Btn active color="56,189,248">
                📍 Click canvas to place start
              </Btn>
          ) : (
              <div style={{display:"flex",gap:3,alignItems:"center"}}>
                <span style={{fontSize:9,color:"#475569"}}>START:</span>
                <button onClick={()=>setMarker(m=>({...m,angleDeg:(m.angleDeg-45+360)%360}))} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 7px",color:"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>↺</button>
                <span style={{fontSize:10,color:"#94a3b8",minWidth:30,textAlign:"center"}}>{marker.angleDeg}°</span>
                <button onClick={()=>setMarker(m=>({...m,angleDeg:(m.angleDeg+45)%360}))} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 7px",color:"#94a3b8",fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>↻</button>
                <button onClick={()=>{setMarkerPlaced(false);setTracks([mkTrack(0)]);setActiveTrack(0);}} style={{background:"transparent",border:"1px solid #334155",borderRadius:3,padding:"2px 7px",color:"#ef4444",fontSize:10,fontFamily:"monospace",cursor:"pointer"}} title="Remove start marker and clear layout">✕ Reset</button>
              </div>
          )}

          {/* Track selector */}
          {markerPlaced && (
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <span style={{fontSize:9,color:"#475569"}}>TRACK:</span>
                <select value={activeTrack} onChange={e=>setActiveTrack(Number(e.target.value))} style={{background:"#1e293b",border:`1px solid ${activeColor}`,borderRadius:4,padding:"3px 7px",color:activeColor,fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>
                  {tracks.map((c,i)=>(
                      <option key={i} value={i} style={{color:TRACK_COLORS[i%TRACK_COLORS.length]}}>{c.label}</option>
                  ))}
                </select>
                <button onClick={addTrack} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 8px",color:"#22c55e",fontSize:13,fontFamily:"monospace",cursor:"pointer"}} title="Add track">+</button>
                <button onClick={()=>removeTrack(activeTrack)} disabled={tracks.length<=1} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:3,padding:"2px 8px",color:tracks.length<=1?"#334155":"#ef4444",fontSize:13,fontFamily:"monospace",cursor:tracks.length<=1?"default":"pointer"}} title="Remove active track">−</button>
              </div>
          )}

          {/* Draw Table */}
          <Btn onClick={()=>{if(tMode)cancelTable();else{setTMode(true);setDraft([]);}}} active={tMode} color="245,158,11">
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

          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
            {/* Help Button */}
            <Btn onClick={()=>setShowHelp(true)} title="Show help and keyboard shortcuts">Help</Btn>

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
              <Btn title="Fit table in view" onClick={fitToView}>⌂</Btn>
            </div>
          </div>
        </div>

        {/* ── Main ── */}
        <div style={{display:"flex",flex:1,overflow:"hidden"}}>
          <Palette onAdd={addPiece} filter={filter} setFilter={setFilter}/>

          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            <div onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}
                 style={{flex:1,position:"relative",overflow:"hidden",
                   cursor:tMode?"crosshair":draggingMarker?"grabbing":"default"}}>
              <canvas ref={canvasRef} style={{display:"block",width:"100%",height:"100%"}}/>

              <div style={{position:"absolute",bottom:8,right:8,fontSize:9,color:"#334155",fontFamily:"monospace"}}>
                Drag start marker · Alt+drag or middle-click to pan · Scroll to zoom
              </div>

              {/* First-time prompt */}
              {!markerPlaced&&!tMode&&(
                  <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",textAlign:"center",pointerEvents:"none"}}>
                    <div style={{fontSize:13,color:"#475569",fontFamily:"monospace",marginBottom:8}}>Click anywhere to place the start marker</div>
                    <div style={{fontSize:10,color:"#334155",fontFamily:"monospace"}}>Drag it any time to reposition</div>
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
              {selectedPiece && !tMode && (() => {
                const track = tracks[selectedPiece.trackIdx];
                const piece = track?.pieces[selectedPiece.pieceIdx];
                if (!piece) return null;
                const color = TRACK_COLORS[selectedPiece.trackIdx % TRACK_COLORS.length];
                const popLeft = Math.min(Math.max(8, selectedPiece.screenX - 125), window.innerWidth - 310);
                const popTop = Math.max(8, selectedPiece.screenY - 240);
                const types = ["straight","curve","ramp"];
                const filtered = PIECES.filter(p =>
                    popupMode === "replace"
                        ? p.id !== piece.id && (!popupTypeFilter || p.type === popupTypeFilter)
                        : !popupTypeFilter || p.type === popupTypeFilter
                );
                const applyPiece = (p) => {
                  setTracks(prev => prev.map((c,ci) => {
                    if (ci !== selectedPiece.trackIdx) return c;
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
                                setTracks(prev => prev.map((c,ci) => ci !== selectedPiece.trackIdx ? c : {
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

              {/* Add/Undo */}
              {!tMode&&markerPlaced&&(
                  <div style={{position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",display:"flex",gap:6,alignItems:"center"}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:activeColor,boxShadow:`0 0 8px ${activeColor}`}}/>
                    <span style={{fontSize:10,color:activeColor,fontFamily:"monospace"}}>{tracks[activeTrack]?.label}</span>
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
                      {laneData.map(({trackIdx,l1,l2})=>{
                        const color=TRACK_COLORS[trackIdx%TRACK_COLORS.length];
                        const delta=Math.abs(l1-l2);
                        return (
                            <div key={trackIdx} style={{display:"flex",gap:8,alignItems:"center"}}>
                              <span style={{fontSize:10,color,fontFamily:"monospace",fontWeight:"bold"}}>C{trackIdx+1}</span>
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
              {tracks.some(c=>c.pieces.length>0)&&(
                  <div>
                    <div style={{fontSize:10,color:"#475569",fontFamily:"monospace",marginBottom:4}}>BILL OF MATERIALS</div>
                    <BOM tracks={tracks}/>
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

        {/* Help Menu */}
        {showHelp && <HelpMenu onClose={()=>setShowHelp(false)} />}
      </div>
  );
}
