/**
 * PenFight Arena v4 – game.js
 * Client-side interpolation, collision sparks, screen-shake,
 * smooth pen movement, map-aware rendering.
 */
'use strict';

// ── Pen catalogue ──────────────────────────────────────────────────────────────
const PEN_TYPES = {
  ballpoint:   {width:120,height:32,weight:1.2,defense:0.28,color:'#2b2b2b',emoji:'🖊️',name:'Ballpoint'},
  gel:         {width:100,height:26,weight:0.8,defense:0.12,color:'#00bcd4',emoji:'🖋️',name:'Gel Pen'},
  fountain:    {width:140,height:40,weight:2.0,defense:0.70,color:'#8b4513',emoji:'✒️',name:'Fountain'},
  marker:      {width:130,height:38,weight:1.7,defense:0.42,color:'#ff5722',emoji:'🖍️',name:'Marker'},
  highlighter: {width:115,height:34,weight:0.9,defense:0.18,color:'#ffeb3b',emoji:'✏️',name:'Highlighter'},
  stylus:      {width: 90,height:22,weight:2.4,defense:0.88,color:'#9c27b0',emoji:'📌',name:'Stylus'},
};

const TABLE   = {left:60,right:740,top:60,bottom:540};
const MAX_POWER = 5.5;    // raw cap (server scales by map)
const WIN_ROUNDS = 2;

// ── Runtime state ──────────────────────────────────────────────────────────────
let socket, myPlayerId, myRoomCode, isHost = false;
let gameState    = null;
let prevState    = null;    // for interpolation
let interpT      = 0;       // 0..1 interpolation progress
let isSimulating = false;
let dragState    = null;
let mapsMeta     = {};
let currentMap   = 'classic';
let roundWins    = {};
let currentRound = 1;

// Sprites
const sprites = {};
let spritesReady = false;

// Particles (sparks from collisions)
const particles  = [];
// Screen-shake
let shakeX = 0, shakeY = 0, shakeDur = 0, shakeAmp = 0;
// Trails
const trails = [];
// Per-pen smooth state (for client-side interpolation)
const smoothPens = {};   // pid → {x,y,angle}

// Canvas
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');
let animFrame = null;
const glowT   = {v: 0};

// Background cache
const bgCache = {};

// ── Loaders ────────────────────────────────────────────────────────────────────
async function loadSprites() {
  try {
    const res  = await fetch('/api/sprites');
    const data = await res.json();
    let pending = Object.keys(data).length;
    if (!pending) { spritesReady = true; return; }
    for (const [k, b64] of Object.entries(data)) {
      const img = new Image();
      img.onload  = () => { sprites[k] = img; if (--pending === 0) spritesReady = true; };
      img.onerror = () => { if (--pending === 0) spritesReady = true; };
      img.src = b64;
    }
  } catch { spritesReady = true; }
}

async function loadMaps() {
  try {
    const res = await fetch('/api/maps');
    mapsMeta  = await res.json();
  } catch(e) { console.warn(e); }
}

// ── Particle system ────────────────────────────────────────────────────────────
function spawnSparks(x, y, impulse, count = 10) {
  const speed = Math.min(impulse * 0.6, 8);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd   = speed * (0.3 + Math.random() * 0.7);
    particles.push({
      x, y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      life: 1.0,
      decay: 0.035 + Math.random() * 0.04,
      size: 1.5 + Math.random() * 3,
      color: `hsl(${30 + Math.random()*40},90%,${60+Math.random()*30}%)`,
    });
  }
}

function spawnTeleportBurst(x, y, color) {
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    particles.push({
      x, y,
      vx: Math.cos(angle) * (2 + Math.random()*3),
      vy: Math.sin(angle) * (2 + Math.random()*3),
      life: 1.0, decay: 0.025, size: 2 + Math.random()*3,
      color,
    });
  }
}

function triggerShake(amp) {
  shakeAmp = Math.min(amp, 12);
  shakeDur = 18;
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.88; p.vy *= 0.88;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  particles.forEach(p => {
    ctx.save();
    ctx.globalAlpha = p.life * p.life;   // quadratic fade = sharper start
    ctx.fillStyle   = p.color;
    ctx.shadowBlur  = 6; ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  });
}

// ── Smooth interpolation for pen positions ─────────────────────────────────────
function initSmoothPens(pens) {
  Object.entries(pens).forEach(([pid, pen]) => {
    smoothPens[pid] = {x: pen.x, y: pen.y, angle: pen.angle};
  });
}

// Lerp angle properly (handles wrap-around)
function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function updateSmoothPens(newPens) {
  if (!newPens) return;
  const LERP = isSimulating ? 0.22 : 0.18;   // faster snap during physics
  Object.entries(newPens).forEach(([pid, pen]) => {
    if (!pen.alive) return;
    if (!smoothPens[pid]) {
      smoothPens[pid] = {x: pen.x, y: pen.y, angle: pen.angle};
      return;
    }
    const s = smoothPens[pid];
    s.x     = s.x     + (pen.x     - s.x)     * LERP;
    s.y     = s.y     + (pen.y     - s.y)     * LERP;
    s.angle = lerpAngle(s.angle, pen.angle, LERP);
  });
}

// ── Trails ─────────────────────────────────────────────────────────────────────
function genTrails(oldPens, newPens) {
  if (!oldPens || !newPens) return;
  Object.entries(newPens).forEach(([pid, pen]) => {
    if (!pen.alive) return;
    const old = oldPens[pid]; if (!old) return;
    const spd = Math.hypot(pen.x - old.x, pen.y - old.y);
    if (spd < 0.8) return;
    if (trails.length > 400) trails.splice(0, 50);
    trails.push({
      x: old.x, y: old.y, angle: old.angle,
      width: pen.width, height: pen.height,
      color: pen.color, type: pen.type, life: 1.0,
      speed: spd,
    });
  });
}

// ── Background builder ─────────────────────────────────────────────────────────
function buildBg(mapKey) {
  if (bgCache[mapKey]) return bgCache[mapKey];
  const off = document.createElement('canvas');
  off.width  = canvas.width;
  off.height = canvas.height;
  const oc   = off.getContext('2d');
  const {left:L,right:R,top:T,bottom:B} = TABLE;
  const W = R-L, H = B-T;

  // Outer shadow
  oc.fillStyle = '#1a1008';
  oc.beginPath(); oc.roundRect(L-12,T-12,W+24,H+24,20); oc.fill();

  oc.save();
  oc.beginPath(); oc.roundRect(L,T,W,H,12); oc.clip();

  if (mapKey === 'classic') {
    oc.fillStyle = '#7a5230'; oc.fillRect(L,T,W,H);
    for (let i=0;i<55;i++){
      const y=T+i*9+Math.random()*4;
      oc.beginPath(); oc.moveTo(L,y);
      for(let x=L;x<R;x+=8) oc.lineTo(x,y+(Math.random()-.5)*2.5);
      oc.strokeStyle=`rgba(0,0,0,${.025+Math.random()*.06})`;
      oc.lineWidth=.6+Math.random(); oc.stroke();
    }
    for(let k=0;k<5;k++){
      const kx=L+30+Math.random()*(W-60), ky=T+20+Math.random()*(H-40);
      const g=oc.createRadialGradient(kx,ky,2,kx,ky,18);
      g.addColorStop(0,'rgba(50,25,8,.25)'); g.addColorStop(1,'rgba(50,25,8,0)');
      oc.fillStyle=g; oc.fillRect(kx-20,ky-20,40,40);
    }

  } else if (mapKey === 'ice') {
    const ig=oc.createLinearGradient(L,T,R,B);
    ig.addColorStop(0,'#daf4ff'); ig.addColorStop(.5,'#b8eaf8'); ig.addColorStop(1,'#cdf0ff');
    oc.fillStyle=ig; oc.fillRect(L,T,W,H);
    oc.strokeStyle='rgba(100,190,230,.45)'; oc.lineWidth=1;
    for(let c=0;c<22;c++){
      const sx=L+Math.random()*W, sy=T+Math.random()*H;
      oc.beginPath(); oc.moveTo(sx,sy);
      let cx2=sx,cy2=sy;
      for(let s=0;s<7;s++){cx2+=(Math.random()-.5)*38;cy2+=(Math.random()-.5)*28;oc.lineTo(cx2,cy2);}
      oc.stroke();
    }
    for(let d=0;d<80;d++){
      oc.fillStyle=`rgba(255,255,255,${.25+Math.random()*.55})`;
      oc.beginPath();
      oc.arc(L+Math.random()*W,T+Math.random()*H,.5+Math.random()*1.5,0,Math.PI*2);
      oc.fill();
    }

  } else if (mapKey === 'sandpaper') {
    oc.fillStyle='#c8a96e'; oc.fillRect(L,T,W,H);
    for(let n=0;n<5000;n++){
      const px=L+Math.random()*W, py=T+Math.random()*H;
      oc.fillStyle=Math.random()>.6
        ?`rgba(255,220,140,${.12+Math.random()*.22})`
        :`rgba(80,50,10,${.07+Math.random()*.18})`;
      oc.fillRect(px,py,1+Math.random()*2,1+Math.random()*2);
    }
    oc.strokeStyle='rgba(100,65,20,.1)';
    for(let g=0;g<35;g++){
      oc.lineWidth=.5+Math.random()*1.5;
      oc.beginPath();
      oc.moveTo(L+Math.random()*W,T);
      oc.bezierCurveTo(
        L+Math.random()*W, T+H*0.33,
        L+Math.random()*W, T+H*0.66,
        L+Math.random()*W, B);
      oc.stroke();
    }

  } else if (mapKey === 'portal') {
    const pg=oc.createRadialGradient((L+R)/2,(T+B)/2,40,(L+R)/2,(T+B)/2,320);
    pg.addColorStop(0,'#1a0a2e'); pg.addColorStop(1,'#0d0018');
    oc.fillStyle=pg; oc.fillRect(L,T,W,H);
    for(let s=0;s<130;s++){
      oc.fillStyle=`rgba(255,255,255,${.08+Math.random()*.45})`;
      oc.beginPath();
      oc.arc(L+Math.random()*W,T+Math.random()*H,Math.random()*1.3,0,Math.PI*2);
      oc.fill();
    }
    const hexR=28; oc.strokeStyle='rgba(168,85,247,.07)'; oc.lineWidth=1;
    for(let row=-1;row<H/hexR+2;row++){
      for(let col=-1;col<W/(hexR*1.732)+2;col++){
        const hx=L+col*hexR*1.732+(row%2)*hexR*.866;
        const hy=T+row*hexR*1.5;
        oc.beginPath();
        for(let i=0;i<6;i++){
          const ang=Math.PI/180*60*i-Math.PI/6;
          i===0?oc.moveTo(hx+hexR*.85*Math.cos(ang),hy+hexR*.85*Math.sin(ang))
               :oc.lineTo(hx+hexR*.85*Math.cos(ang),hy+hexR*.85*Math.sin(ang));
        }
        oc.closePath(); oc.stroke();
      }
    }
  }

  // Vignette
  const vig=oc.createRadialGradient((L+R)/2,(T+B)/2,80,(L+R)/2,(T+B)/2,370);
  vig.addColorStop(0,'rgba(0,0,0,0)');
  vig.addColorStop(1,mapKey==='ice'?'rgba(0,50,80,.15)':'rgba(0,0,0,.32)');
  oc.fillStyle=vig; oc.fillRect(L,T,W,H);
  oc.restore();

  // ── TABLE EDGE: looks like a real table top with a drop-off ─────────────
  // Outer drop-shadow (the "table side" visible below the surface)
  oc.save();
  oc.shadowBlur  = 0;
  // Left side panel
  oc.fillStyle = mapKey==='ice' ? '#5ba3c9'
               : mapKey==='portal' ? '#3b0764'
               : mapKey==='sandpaper' ? '#92601a'
               : '#4a2e0a';
  // Bottom panel (thick edge visible when looking at a table from above)
  const edgeT = 10;   // edge thickness in px
  oc.fillRect(L-edgeT, T, edgeT, H+edgeT);          // left side
  oc.fillRect(R,        T, edgeT, H+edgeT);          // right side
  oc.fillRect(L-edgeT, B, W+edgeT*2, edgeT);         // bottom side
  oc.fillRect(L-edgeT, T-edgeT, W+edgeT*2, edgeT);  // top side
  oc.restore();

  // Edge fade — table surface fades to darker right at the rim (depth cue)
  const edgeFadeW = 22;
  const makeEdgeFade = (x0,y0,x1,y1) => {
    const g = oc.createLinearGradient(x0,y0,x1,y1);
    g.addColorStop(0,'rgba(0,0,0,0.0)');
    g.addColorStop(1,'rgba(0,0,0,0.38)');
    return g;
  };
  oc.fillStyle = makeEdgeFade(L+edgeFadeW,0, L,0);
  oc.fillRect(L, T, edgeFadeW, H);
  oc.fillStyle = makeEdgeFade(R-edgeFadeW,0, R,0);
  oc.fillRect(R-edgeFadeW, T, edgeFadeW, H);
  oc.fillStyle = makeEdgeFade(0,T+edgeFadeW, 0,T);
  oc.fillRect(L, T, W, edgeFadeW);
  oc.fillStyle = makeEdgeFade(0,B-edgeFadeW, 0,B);
  oc.fillRect(L, B-edgeFadeW, W, edgeFadeW);

  // Rim line — bright highlight right at the edge, like table edge catching light
  const rimColor = mapKey==='portal' ? 'rgba(168,85,247,0.7)'
                 : mapKey==='ice'    ? 'rgba(180,235,255,0.7)'
                 : mapKey==='sandpaper' ? 'rgba(220,170,80,0.7)'
                 : 'rgba(210,160,80,0.75)';
  oc.strokeStyle = rimColor;
  oc.lineWidth   = 3;
  oc.beginPath(); oc.roundRect(L, T, W, H, 6); oc.stroke();

  // Outer glow (table edge casts soft shadow on the background)
  oc.strokeStyle = 'rgba(0,0,0,0.6)';
  oc.lineWidth   = 14;
  oc.beginPath(); oc.roundRect(L-4, T-4, W+8, H+8, 10); oc.stroke();

  // Corner circles
  [[L,T],[R,T],[R,B],[L,B]].forEach(([x,y])=>{
    oc.fillStyle='rgba(0,0,0,0.5)';
    oc.beginPath(); oc.arc(x,y,8,0,Math.PI*2); oc.fill();
    oc.fillStyle=rimColor;
    oc.beginPath(); oc.arc(x,y,5,0,Math.PI*2); oc.fill();
  });

  // Centre crosshair
  oc.strokeStyle='rgba(255,255,255,.05)'; oc.lineWidth=1; oc.setLineDash([4,8]);
  oc.beginPath(); oc.moveTo((L+R)/2,T); oc.lineTo((L+R)/2,B); oc.stroke();
  oc.beginPath(); oc.moveTo(L,(T+B)/2); oc.lineTo(R,(T+B)/2); oc.stroke();
  oc.setLineDash([]);

  bgCache[mapKey] = off;
  return off;
}

// ── Portal drawing ─────────────────────────────────────────────────────────────
let shimmerT = 0;
function drawPortals(portals) {
  if (!portals?.length) return;
  const t = glowT.v;
  portals.forEach(p => {
    drawPortalMouth(p.ax, p.ay, p.radius, p.color  || '#a855f7', t,  1);
    drawPortalMouth(p.bx, p.by, p.radius, p.color2 || '#f97316', t, -1);
  });
}

function drawPortalMouth(x, y, r, color, t, spin) {
  ctx.save(); ctx.translate(x, y);
  // Outer glow
  const g1 = ctx.createRadialGradient(0,0,0,0,0,r*2.2);
  g1.addColorStop(0, hexAlpha(color, 0.3));
  g1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g1;
  ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
  // Spinning dashed ring
  ctx.rotate(t * spin * 1.8);
  ctx.strokeStyle = color; ctx.lineWidth = 2.8;
  ctx.setLineDash([9,7]);
  ctx.globalAlpha = 0.75;
  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.stroke();
  ctx.setLineDash([]);
  // Inner glow
  const pulse = 0.5 + 0.5*Math.sin(t*2.5);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.35 + 0.25*pulse;
  ctx.beginPath(); ctx.arc(0,0,r*0.52,0,Math.PI*2); ctx.stroke();
  // Core
  const gc = ctx.createRadialGradient(0,0,0,0,0,r*0.42);
  gc.addColorStop(0,'rgba(255,255,255,0.55)');
  gc.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle = gc; ctx.globalAlpha = pulse;
  ctx.beginPath(); ctx.arc(0,0,r*0.42,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

function hexAlpha(hex, alpha) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Map ambient effects ────────────────────────────────────────────────────────
function drawIceShimmer() {
  shimmerT += 0.025;
  const {left:L,right:R,top:T,bottom:B} = TABLE;
  for (let i=0;i<5;i++){
    const x=L+(R-L)*((Math.sin(shimmerT+i*1.4)*.5+.5));
    const y=T+(B-T)*((Math.cos(shimmerT*.7+i*1.1)*.5+.5));
    const g=ctx.createRadialGradient(x,y,0,x,y,45);
    g.addColorStop(0,'rgba(200,240,255,0.1)');
    g.addColorStop(1,'rgba(200,240,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,45,0,Math.PI*2); ctx.fill();
  }
}

function drawSandDust() {
  shimmerT += 0.018;
  const {left:L,right:R,top:T,bottom:B} = TABLE;
  ctx.save(); ctx.globalAlpha=0.055;
  for(let i=0;i<10;i++){
    const x=L+(R-L)*((Math.sin(shimmerT*.6+i*2.1)*.5+.5));
    const y=T+(B-T)*((Math.cos(shimmerT*.5+i*1.9)*.5+.5));
    ctx.fillStyle='#d4a050';
    ctx.beginPath(); ctx.arc(x,y,1.5+Math.abs(Math.sin(shimmerT+i))*2,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  glowT.v += 0.05;

  // Screen shake decay
  if (shakeDur > 0) {
    shakeX = (Math.random()-.5) * shakeAmp * (shakeDur/18);
    shakeY = (Math.random()-.5) * shakeAmp * (shakeDur/18);
    shakeDur--;
  } else { shakeX = 0; shakeY = 0; }

  ctx.save();
  ctx.translate(shakeX, shakeY);
  ctx.clearRect(-20,-20,canvas.width+40,canvas.height+40);

  // Background
  ctx.drawImage(buildBg(currentMap), 0, 0);

  // Map ambient
  if (currentMap==='portal' && mapsMeta[currentMap])
    drawPortals(mapsMeta[currentMap].portals);
  if (currentMap==='ice')        drawIceShimmer();
  if (currentMap==='sandpaper')  drawSandDust();

  // Edge danger glow — pulses red when any pen is near the boundary
  drawEdgeWarning();

  // Update interpolated positions
  if (gameState?.pens) updateSmoothPens(gameState.pens);

  // Trails
  for (let i=trails.length-1;i>=0;i--){
    trails[i].life -= 0.048;
    if (trails[i].life<=0){ trails.splice(i,1); continue; }
    drawTrail(trails[i]);
  }

  // Pens (using smoothed positions)
  if (gameState?.pens) {
    Object.entries(gameState.pens).forEach(([pid,pen]) => {
      drawPen(pen, pid, pid===gameState.currentTurn && !isSimulating);
    });
  }

  updateParticles();
  drawParticles();
  drawAim();

  ctx.restore();
}

function drawTrail(t) {
  ctx.save();
  ctx.globalAlpha = t.life * 0.22;
  const s = smoothPens[Object.keys(smoothPens).find(pid =>
    gameState?.pens?.[pid]?.type === t.type)] || null;
  ctx.translate(t.x, t.y); ctx.rotate(t.angle);
  const spr = sprites[t.type];
  if (spr) {
    ctx.drawImage(spr,-t.width/2,-t.height/2,t.width,t.height);
  } else {
    ctx.fillStyle=t.color;
    ctx.beginPath(); ctx.roundRect(-t.width/2,-t.height/2,t.width,t.height,4); ctx.fill();
  }
  ctx.restore();
}

function drawPen(pen, pid, isActive) {
  if (!pen.alive) return;
  const s   = smoothPens[pid] || {x:pen.x, y:pen.y, angle:pen.angle};
  const spr = sprites[pen.type];

  ctx.save();
  ctx.translate(s.x, s.y); ctx.rotate(s.angle);

  if (isActive) {
    const pulse = 0.5 + 0.5*Math.sin(glowT.v*3);
    ctx.shadowBlur  = 22 + pulse*18; ctx.shadowColor = '#f0c040';
  } else {
    ctx.shadowBlur  = 10; ctx.shadowColor = 'rgba(0,0,0,.75)';
  }

  if (spr && spritesReady) {
    ctx.drawImage(spr,-pen.width/2,-pen.height/2,pen.width,pen.height);
  } else {
    const grad=ctx.createLinearGradient(-pen.width/2,-pen.height/2,pen.width/2,pen.height/2);
    grad.addColorStop(0,lighten(pen.color,55));
    grad.addColorStop(.5,pen.color);
    grad.addColorStop(1,darken(pen.color,38));
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.roundRect(-pen.width/2,-pen.height/2,pen.width,pen.height,6); ctx.fill();
    const gloss=ctx.createLinearGradient(-pen.width/2,-pen.height/2,pen.width/2,0);
    gloss.addColorStop(0,'rgba(255,255,255,.24)'); gloss.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=gloss;
    ctx.beginPath(); ctx.roundRect(-pen.width/2,-pen.height/2,pen.width,pen.height/2,6); ctx.fill();
    // Border
    ctx.strokeStyle='rgba(255,255,255,.14)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.roundRect(-pen.width/2,-pen.height/2,pen.width,pen.height,6); ctx.stroke();
  }
  ctx.restore();

  // Label (always upright)
  if (gameState?.players?.[pid]) {
    const name   = gameState.players[pid].name;
    const labelY = s.y - pen.height/2 - 10;
    ctx.save();
    ctx.font='bold 11px "DM Mono",monospace';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    const tw = ctx.measureText(name.slice(0,9)).width;
    ctx.fillStyle=isActive?'rgba(240,192,64,.28)':'rgba(0,0,0,.5)';
    ctx.beginPath(); ctx.roundRect(s.x-tw/2-7,labelY-15,tw+14,17,9); ctx.fill();
    ctx.fillStyle=isActive?'#f0c040':'rgba(255,255,255,.88)';
    ctx.fillText(name.slice(0,9), s.x, labelY);
    // Win dots
    const w = roundWins[pid]||0;
    for(let i=0;i<w;i++){
      ctx.fillStyle='#f0c040';
      ctx.beginPath(); ctx.arc(s.x+tw/2+12+i*11,labelY-8,3.5,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }
}

function drawAim() {
  if (!dragState?.active||!gameState||!isMyTurn()||isSimulating) return;
  const pen=gameState.pens?.[myPlayerId]; if(!pen?.alive) return;
  const s = smoothPens[myPlayerId]||{x:pen.x,y:pen.y};

  const {startX,startY,currentX,currentY}=dragState;
  const ddx=currentX-startX, ddy=currentY-startY;
  const dlen=Math.hypot(ddx,ddy); if(dlen<4) return;

  const shotDx=-ddx/dlen, shotDy=-ddy/dlen;
  const power=Math.min(dlen*0.10, MAX_POWER);
  const arrowLen=65+power*10;
  const ax=s.x+shotDx*arrowLen, ay=s.y+shotDy*arrowLen;

  ctx.save();

  // Dashed line
  ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=2.5; ctx.setLineDash([8,5]);
  ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(ax,ay); ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const ang=Math.atan2(shotDy,shotDx);
  ctx.fillStyle='white';
  ctx.beginPath();
  ctx.moveTo(ax,ay);
  ctx.lineTo(ax-14*Math.cos(ang-.42),ay-14*Math.sin(ang-.42));
  ctx.lineTo(ax-14*Math.cos(ang+.42),ay-14*Math.sin(ang+.42));
  ctx.closePath(); ctx.fill();

  // Rubber-band line
  ctx.strokeStyle='rgba(255,77,109,.55)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
  ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(currentX,currentY); ctx.stroke();
  ctx.setLineDash([]);

  // Power bar
  const hue=120-power*13;
  const barW=260,barH=10,barX=canvas.width/2-barW/2,barY=canvas.height-22;
  ctx.globalAlpha=1;
  ctx.fillStyle='rgba(0,0,0,.6)';
  ctx.beginPath(); ctx.roundRect(barX-3,barY-3,barW+6,barH+6,6); ctx.fill();
  const fillW=(power/MAX_POWER)*barW;
  const bg=ctx.createLinearGradient(barX,0,barX+fillW,0);
  bg.addColorStop(0,'#22c55e'); bg.addColorStop(.6,`hsl(${hue},80%,55%)`); bg.addColorStop(1,'#ef4444');
  ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(barX,barY,fillW,barH,4); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.75)';
  ctx.font='11px "DM Mono",monospace'; ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.fillText(`POWER  ${power.toFixed(1)} / ${MAX_POWER}`,canvas.width/2,barY-7);

  ctx.restore();
}

function drawEdgeWarning() {
  // Show how far each pen is hanging off the edge.
  // When half the body is outside → eliminated (matches server logic).
  if (!gameState?.pens) return;
  const {left:L, right:R, top:T, bottom:B} = TABLE;

  Object.entries(gameState.pens).forEach(([pid, pen]) => {
    if (!pen.alive) return;
    const s = smoothPens[pid] || {x:pen.x, y:pen.y, angle:pen.angle||0};

    // Rotated half-extents (same formula as server check_elimination)
    const hw    = pen.width  / 2;
    const hh    = pen.height / 2;
    const cosA  = Math.abs(Math.cos(s.angle));
    const sinA  = Math.abs(Math.sin(s.angle));
    const extX  = hw * cosA + hh * sinA;
    const extY  = hw * sinA + hh * cosA;

    // How far over each edge the pen is (positive = outside)
    const overR = (s.x + extX) - R;
    const overL = L - (s.x - extX);
    const overB = (s.y + extY) - B;
    const overT = T - (s.y - extY);
    const maxOver = Math.max(overR, overL, overB, overT);

    if (maxOver <= 0) return;

    // danger 0→1 as pen goes from touching edge to half-body outside
    const danger = Math.min(maxOver / (extX * 0.5), 1.0);
    if (danger <= 0.05) return;

    const pulse = 0.55 + 0.45 * Math.sin(glowT.v * 5);
    const alpha = danger * pulse;

    // Draw danger arc around that pen
    ctx.save();
    ctx.strokeStyle = `rgba(255, ${Math.round(60*(1-danger))}, 60, ${alpha * 0.85})`;
    ctx.lineWidth   = 3 + danger * 4;
    ctx.shadowBlur  = 12 * danger; ctx.shadowColor = `rgba(255,40,40,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, extX + 6, extY + 6, s.angle, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Also tint the table rim in the direction of the fall
    ctx.save();
    ctx.globalAlpha = danger * pulse * 0.4;
    ctx.fillStyle   = '#ff3030';
    if (overR > 0) ctx.fillRect(R-8, T, 8, B-T);
    if (overL > 0) ctx.fillRect(L,   T, 8, B-T);
    if (overB > 0) ctx.fillRect(L,   B-8, R-L, 8);
    if (overT > 0) ctx.fillRect(L,   T,   R-L, 8);
    ctx.restore();
  });
}

function startLoop() {
  if (animFrame) cancelAnimationFrame(animFrame);
  const loop = () => { render(); animFrame=requestAnimationFrame(loop); };
  loop();
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function lighten(hex,a){return adjustColor(hex, a);}
function darken (hex,a){return adjustColor(hex,-a);}
function adjustColor(hex,a){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgb(${clamp(r+a)},${clamp(g+a)},${clamp(b+a)})`;
}
function clamp(v){return Math.max(0,Math.min(255,v));}

// ── Socket.IO ──────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io();

  socket.on('room_created', d => {
    myPlayerId=d.playerId; myRoomCode=d.code; isHost=true;
    document.getElementById('lobby-code').textContent=d.code;
    document.getElementById('btn-start').disabled=false;
    document.getElementById('host-hint').textContent='You are the host — share the code!';
    showScreen('lobby');
    updateLobbyPlayers(d.players,d.host);
    setupMapCards(true);
  });

  socket.on('room_joined', d => {
    myPlayerId=d.playerId; myRoomCode=d.code; isHost=false;
    document.getElementById('lobby-code').textContent=d.code;
    document.getElementById('btn-start').disabled=true;
    document.getElementById('host-hint').textContent='Waiting for host to start…';
    showScreen('lobby');
    updateLobbyPlayers(d.players,d.host);
    setupMapCards(false);
  });

  socket.on('player_joined', d => { updateLobbyPlayers(d.players,null); toast(`${d.name} joined!`); });
  socket.on('player_left',   ()  => toast('A player disconnected'));

  socket.on('pen_selected', d => {
    const el=document.querySelector(`#player-list li[data-pid="${d.playerId}"] .pen-badge`);
    if(el) el.textContent=PEN_TYPES[d.penType]?.emoji??'?';
  });

  socket.on('map_selected', d => {
    currentMap=d.mapKey;
    document.querySelectorAll('.map-card').forEach(c=>c.classList.toggle('selected',c.dataset.key===d.mapKey));
    toast(`Map: ${mapsMeta[d.mapKey]?.name??d.mapKey}`);
  });

  socket.on('round_started', state => {
    prevState    = null;
    gameState    = state;
    isSimulating = false;
    currentMap   = state.map;
    currentRound = state.round;
    roundWins    = state.roundWins||{};
    document.getElementById('overlay-round').classList.add('hidden');
    document.body.className=`map-${currentMap}`;
    showScreen('game');
    // Init smooth positions
    initSmoothPens(state.pens);
    if(!animFrame) startLoop();
    updateHUD(); updateBanner();
    setMessage(isMyTurn()?'🎯 Your turn! Drag backward to aim.':`${getCurrentName()}'s turn…`);
  });

  socket.on('game_state_update', state => {
    // Fire collision sparks from server events
    if (state.collisionEvents?.length) {
      state.collisionEvents.forEach(ev => {
        spawnSparks(ev.x, ev.y, ev.impulse, Math.ceil(ev.impulse*1.2));
        if (ev.impulse > 4) triggerShake(ev.impulse * 0.5);
      });
    }
    if (gameState) genTrails(gameState.pens, state.pens);
    gameState    = state;
    isSimulating = state.simulating;
    roundWins    = state.roundWins||roundWins;
    currentRound = state.round||currentRound;
    updateHUD(); updateBanner();
    if(!isSimulating){
      document.getElementById('btn-skip').classList.add('hidden');
      // Show eliminated pens flying off (spawn death particles)
      if (state.eliminated?.length) {
        state.eliminated.forEach(pid => {
          const pen = state.pens?.[pid];
          if (pen) spawnSparks(pen.x, pen.y, 12, 25);
        });
      }
      setMessage(isMyTurn()?'🎯 Your turn!':`${getCurrentName()}'s turn…`);
    }
  });

  socket.on('round_over', d => {
    roundWins=d.roundWins||roundWins;
    showRoundOverlay(d.roundWinnerName,d.roundWins,d.nextRound);
    toast(`Round → ${d.roundWinnerName} wins!`);
  });

  socket.on('match_over', d => {
    roundWins=d.roundWins||roundWins;
    showMatchOverlay(d.matchWinnerName,d.roundWins);
  });

  socket.on('lobby_reset', d => {
    document.getElementById('overlay-match').classList.add('hidden');
    document.getElementById('overlay-round').classList.add('hidden');
    cancelAnimationFrame(animFrame); animFrame=null;
    gameState=null; currentRound=1; roundWins={};
    document.body.className='';
    updateLobbyPlayers(d.players,d.host);
    setupMapCards(isHost);
    showScreen('lobby');
  });

  socket.on('error', d => toast('⚠ '+d.msg));
}

// ── Overlays ───────────────────────────────────────────────────────────────────
function showRoundOverlay(winnerName,wins,nextRound){
  document.getElementById('round-emoji').textContent=winnerName?'🎯':'🤝';
  document.getElementById('round-title').textContent=`Round ${currentRound} Over!`;
  document.getElementById('round-winner-name').textContent=
    winnerName?`${winnerName} wins this round!`:'No survivor — draw!';
  document.getElementById('next-round-hint').textContent=
    nextRound?`Round ${nextRound} starting in 3.5 s…`:'';
  const sd=document.getElementById('round-score-display'); sd.innerHTML='';
  if(gameState?.players){
    Object.entries(gameState.players).forEach(([pid,p])=>{
      const w=wins[pid]||0;
      const dots=Array.from({length:WIN_ROUNDS},(_,i)=>
        `<div class="sb-dot${i<w?' filled':''}">`).join('');
      const div=document.createElement('div'); div.className='score-block';
      div.innerHTML=`<div class="sb-name">${p.name.slice(0,8)}</div><div class="sb-dots">${dots}</div>`;
      sd.appendChild(div);
    });
  }
  document.getElementById('overlay-round').classList.remove('hidden');
}

function showMatchOverlay(winnerName,wins){
  document.getElementById('overlay-round').classList.add('hidden');
  const myName=gameState?.players?.[myPlayerId]?.name;
  document.getElementById('match-winner-name').textContent=
    winnerName===myName?'🎉 You win the match!':`${winnerName} wins!`;
  const fs=document.getElementById('final-scores'); fs.innerHTML='';
  if(gameState?.players){
    Object.entries(gameState.players).forEach(([pid,p])=>{
      const div=document.createElement('div');
      div.className='final-score-item'+(wins[pid]>=WIN_ROUNDS?' winner':'');
      div.textContent=`${p.name}: ${wins[pid]||0} win${wins[pid]===1?'':'s'}`;
      fs.appendChild(div);
    });
  }
  document.getElementById('overlay-match').classList.remove('hidden');
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
const showScreen=name=>{
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
};
const isMyTurn    =()=>gameState&&gameState.currentTurn===myPlayerId;
const getCurrentName=()=>gameState?.players?.[gameState.currentTurn]?.name??'—';
const setMessage  =msg=>{document.getElementById('game-message').textContent=msg;};

function toast(msg,dur=2800){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'),dur);
}

function updateHUD(){
  if(!gameState) return;
  document.getElementById('hud-turn-name').textContent=getCurrentName();
  document.getElementById('hud-map-tag').textContent=
    `${mapsMeta[currentMap]?.emoji??''} ${mapsMeta[currentMap]?.name??currentMap}`;
  const ul=document.getElementById('hud-player-list'); ul.innerHTML='';
  (gameState.turnOrder||[]).forEach(pid=>{
    const pi=gameState.players?.[pid]; const pen=gameState.pens?.[pid]; if(!pi) return;
    const li=document.createElement('li');
    if(!pen?.alive) li.classList.add('eliminated');
    if(pid===gameState.currentTurn) li.classList.add('your-turn');
    const pt=PEN_TYPES[pi.penType];
    li.innerHTML=`<span>${pt?.emoji??'?'}</span>
      <span>${pi.name.slice(0,10)}${pid===myPlayerId?' (you)':''}</span>`;
    ul.appendChild(li);
  });
}

function updateBanner(){
  document.getElementById('banner-round').textContent=`Round ${currentRound}`;
  document.getElementById('banner-map').textContent=
    `${mapsMeta[currentMap]?.emoji??''} ${mapsMeta[currentMap]?.name??currentMap}`;
  const row=document.getElementById('score-row'); row.innerHTML='';
  if(!gameState?.players) return;
  Object.entries(gameState.players).forEach(([pid,p])=>{
    const w=roundWins[pid]||0;
    const dots=Array.from({length:WIN_ROUNDS},(_,i)=>
      `<div class="win-dot${i<w?' filled':''}">`).join('');
    const div=document.createElement('div'); div.className='score-pip';
    div.innerHTML=`<span>${p.name.slice(0,6)}</span><div class="wins">${dots}</div>`;
    row.appendChild(div);
  });
}

function updateLobbyPlayers(players,hostId){
  const ul=document.getElementById('player-list');
  const cnt=document.getElementById('player-count');
  ul.innerHTML='';
  const entries=Object.entries(players);
  cnt.textContent=`${entries.length}/6`;
  entries.forEach(([pid,p])=>{
    const pt=PEN_TYPES[p.penType];
    const li=document.createElement('li'); li.dataset.pid=pid;
    li.innerHTML=`<span class="pen-badge">${pt?.emoji??'?'}</span>
      <span class="player-name">${p.name}${pid===myPlayerId?' (you)':''}</span>
      ${pid===hostId?'<span class="player-host">HOST</span>':''}`;
    ul.appendChild(li);
  });
}

function setupMapCards(asHost){
  const grid=document.getElementById('map-grid'); grid.innerHTML='';
  Object.entries(mapsMeta).forEach(([key,m])=>{
    const card=document.createElement('div');
    card.className='map-card'+(asHost?' host-control':'')+(key===currentMap?' selected':'');
    card.dataset.key=key;
    card.innerHTML=`
      <div class="map-card-header">
        <span class="map-card-emoji">${m.emoji}</span>
        <span class="map-card-name">${m.name}</span>
      </div>
      <div class="map-card-desc">${m.desc}</div>`;
    if(asHost) card.addEventListener('click',()=>socket.emit('select_map',{mapKey:key}));
    grid.appendChild(card);
  });
  if(!grid.querySelector('.selected')) grid.querySelector('.map-card')?.classList.add('selected');
}

function buildPenGrid(){
  const grid=document.getElementById('pen-grid'); grid.innerHTML='';
  Object.entries(PEN_TYPES).forEach(([key,pt])=>{
    const card=document.createElement('div'); card.className='pen-card'; card.dataset.key=key;
    const preview=sprites[key]
      ?`<img src="${sprites[key].src}" alt="${pt.name}">`
      :`<span class="pen-card-emoji">${pt.emoji}</span>`;
    card.innerHTML=`${preview}
      <span class="pen-card-name">${pt.name}</span>
      <span class="pen-card-stats">⚖${pt.weight} 🛡${pt.defense}</span>
      <div class="pen-card-swatch" style="background:${pt.color}"></div>`;
    card.addEventListener('click',()=>{
      document.querySelectorAll('.pen-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      socket.emit('select_pen',{penType:key});
    });
    grid.appendChild(card);
  });
  grid.querySelector('.pen-card')?.classList.add('selected');
}

// ── Input ──────────────────────────────────────────────────────────────────────
function coords(e){
  const rect=canvas.getBoundingClientRect();
  const sx=canvas.width/rect.width, sy=canvas.height/rect.height;
  const src=e.touches?e.touches[0]:e;
  return {x:(src.clientX-rect.left)*sx, y:(src.clientY-rect.top)*sy};
}
function onDown(e){
  e.preventDefault();
  if(!isMyTurn()||isSimulating||!gameState) return;
  const pen=gameState.pens?.[myPlayerId]; if(!pen?.alive) return;
  const {x,y}=coords(e);
  dragState={startX:x,startY:y,currentX:x,currentY:y,active:true};
}
function onMove(e){
  e.preventDefault();
  if(!dragState?.active) return;
  const {x,y}=coords(e); dragState.currentX=x; dragState.currentY=y;
}
function onUp(e){
  e.preventDefault();
  if(!dragState?.active) return;
  const {startX,startY,currentX,currentY}=dragState; dragState=null;
  if(!isMyTurn()||isSimulating||!gameState) return;
  const ddx=currentX-startX, ddy=currentY-startY;
  const dlen=Math.hypot(ddx,ddy); if(dlen<10) return;
  const dx=-ddx/dlen, dy=-ddy/dlen;
  const power=Math.min(dlen*0.10, MAX_POWER);
  socket.emit('shoot',{dx,dy,power});
  document.getElementById('btn-skip').classList.remove('hidden');
  isSimulating=true; setMessage('Physics running…');
}
canvas.addEventListener('mousedown', onDown,{passive:false});
canvas.addEventListener('mousemove', onMove,{passive:false});
canvas.addEventListener('mouseup',   onUp,  {passive:false});
canvas.addEventListener('mouseleave',onUp,  {passive:false});
canvas.addEventListener('touchstart', onDown,{passive:false});
canvas.addEventListener('touchmove',  onMove,{passive:false});
canvas.addEventListener('touchend',   onUp,  {passive:false});
canvas.addEventListener('touchcancel',onUp,  {passive:false});

// ── Button wiring ──────────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click',()=>{
  const name=document.getElementById('input-name').value.trim()||'Player';
  socket.emit('create_room',{name});
  Promise.all([loadSprites(),loadMaps()]).then(()=>buildPenGrid());
});
document.getElementById('btn-join').addEventListener('click',()=>{
  const name=document.getElementById('input-name').value.trim()||'Player';
  const code=document.getElementById('input-code').value.trim().toUpperCase();
  if(!code||code.length!==4){toast('Enter a 4-letter room code');return;}
  socket.emit('join_room',{name,code});
  Promise.all([loadSprites(),loadMaps()]).then(()=>buildPenGrid());
});
document.getElementById('input-code').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-join').click();});
document.getElementById('input-name').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-create').click();});
document.getElementById('btn-copy-code').addEventListener('click',()=>{
  navigator.clipboard.writeText(myRoomCode||'').then(()=>toast('Room code copied!'));
});
document.getElementById('btn-start').addEventListener('click',()=>socket.emit('start_game'));
document.getElementById('btn-skip').addEventListener('click',()=>socket.emit('skip_physics'));
document.getElementById('btn-replay').addEventListener('click',()=>{
  if(isHost) socket.emit('rematch');
  else toast('Only the host can start a rematch');
});
document.getElementById('btn-menu').addEventListener('click',()=>{
  document.getElementById('overlay-match').classList.add('hidden');
  cancelAnimationFrame(animFrame); animFrame=null;
  gameState=null; document.body.className='';
  showScreen('menu');
});

// ── Boot ───────────────────────────────────────────────────────────────────────
connectSocket();