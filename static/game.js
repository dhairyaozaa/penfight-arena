/**
 * PenFight Arena v8 — game.js
 * Full rewrite: polished UI, sound engine, smooth interpolation,
 * working powerups, random portals/bumpers, 10 pen types.
 */
'use strict';

// ── Pen catalogue (matches server) ────────────────────────────────────────────
const PEN_TYPES = {
  ballpoint:   {width:120,height:32,weight:1.20,defense:0.28,color:'#3a3a3a',  emoji:'🖊️',name:'Ballpoint'},
  gel:         {width:100,height:26,weight:0.80,defense:0.12,color:'#00bcd4',  emoji:'🖋️',name:'Gel Pen'},
  fountain:    {width:140,height:40,weight:2.00,defense:0.70,color:'#8b4513',  emoji:'✒️', name:'Fountain'},
  marker:      {width:130,height:38,weight:1.70,defense:0.42,color:'#ff5722',  emoji:'🖍️',name:'Marker'},
  highlighter: {width:115,height:34,weight:0.90,defense:0.18,color:'#ffeb3b',  emoji:'✏️', name:'Highlighter'},
  stylus:      {width: 90,height:22,weight:2.40,defense:0.88,color:'#9c27b0',  emoji:'📌', name:'Stylus'},
  quill:       {width:155,height:18,weight:0.60,defense:0.08,color:'#f5f0e0',  emoji:'🪶', name:'Quill'},
  crayon:      {width:105,height:44,weight:1.40,defense:0.35,color:'#e91e63',  emoji:'🎨', name:'Crayon'},
  whiteboard:  {width:145,height:36,weight:1.55,defense:0.50,color:'#43a047',  emoji:'🖌️',name:'Whiteboard'},
  needle:      {width: 75,height:12,weight:3.00,defense:0.95,color:'#b0bec5',  emoji:'📍', name:'Needle'},
};

const TABLE      = {left:60,right:740,top:60,bottom:540};
const MAX_POWER  = 6.8;
const WIN_ROUNDS = 2;

// ── State ──────────────────────────────────────────────────────────────────────
let socket, myPlayerId, myRoomCode, isHost=false;
let gameState=null, isSimulating=false, dragState=null;
let mapsMeta={}, currentMap='classic', roundWins={}, currentRound=1;
const sprites={}, smoothPens={};
let spritesReady=false;
const trails=[], particles=[];
let shakeX=0,shakeY=0,shakeDur=0,shakeAmp=0;
let shimmerT=0;
const bgCache={};
const glowT={v:0};
let animFrame=null;

const canvas=document.getElementById('game-canvas');
const ctx=canvas.getContext('2d');

// ── Audio Engine ──────────────────────────────────────────────────────────────
const Audio={
  ctx:null, menuNodes:null, gameNodes:null,
  vol:{master:0.7,sfx:0.8,music:0.35},

  init(){
    try{ this.ctx=new(window.AudioContext||window.webkitAudioContext)(); }
    catch(e){ console.warn('No AudioContext'); }
  },

  resume(){ if(this.ctx&&this.ctx.state==='suspended') this.ctx.resume(); },

  // ── Synth helpers ────────────────────────────────────────────────────────
  _gainNode(vol){
    const g=this.ctx.createGain(); g.gain.value=vol;
    g.connect(this.ctx.destination); return g;
  },

  _osc(type,freq,dur,gainVal,dest,startOffset=0){
    const o=this.ctx.createOscillator();
    const g=this.ctx.createGain();
    o.type=type; o.frequency.value=freq;
    g.gain.setValueAtTime(gainVal,this.ctx.currentTime+startOffset);
    g.gain.exponentialRampToValueAtTime(0.001,this.ctx.currentTime+startOffset+dur);
    o.connect(g); g.connect(dest);
    o.start(this.ctx.currentTime+startOffset);
    o.stop(this.ctx.currentTime+startOffset+dur);
  },

  // ── SFX ─────────────────────────────────────────────────────────────────
  playCollision(impulse){
    if(!this.ctx) return;
    this.resume();
    const vol=Math.min(impulse/15,1)*this.vol.sfx*this.vol.master;
    const g=this._gainNode(vol);
    // Short noise burst for thud
    const buf=this.ctx.createBuffer(1,this.ctx.sampleRate*0.08,this.ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);
    const src=this.ctx.createBufferSource(); src.buffer=buf;
    const filt=this.ctx.createBiquadFilter(); filt.type='bandpass';
    filt.frequency.value=180+impulse*40; filt.Q.value=0.8;
    src.connect(filt); filt.connect(g); src.start();
  },

  playShoot(power){
    if(!this.ctx) return;
    this.resume();
    const vol=power/MAX_POWER*this.vol.sfx*this.vol.master*0.6;
    const g=this._gainNode(vol);
    this._osc('sawtooth',80+power*12,0.15,vol,g);
    this._osc('sine',160,0.08,vol*0.5,g);
  },

  playPickup(){
    if(!this.ctx) return;
    this.resume();
    const g=this._gainNode(this.vol.sfx*this.vol.master*0.7);
    [523,659,784,1047].forEach((f,i)=>this._osc('sine',f,0.12,0.5,g,i*0.07));
  },

  playElimination(){
    if(!this.ctx) return;
    this.resume();
    const g=this._gainNode(this.vol.sfx*this.vol.master);
    this._osc('sawtooth',220,0.06,0.6,g);
    this._osc('sawtooth',165,0.10,0.5,g,0.06);
    this._osc('sawtooth',110,0.18,0.4,g,0.14);
  },

  playRoundWin(){
    if(!this.ctx) return;
    this.resume();
    const g=this._gainNode(this.vol.sfx*this.vol.master);
    [523,659,784,1047,1319].forEach((f,i)=>this._osc('square',f,0.18,0.3,g,i*0.09));
  },

  playPortal(){
    if(!this.ctx) return;
    this.resume();
    const g=this._gainNode(this.vol.sfx*this.vol.master*0.5);
    const o=this.ctx.createOscillator(); const gn=this.ctx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(200,this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(800,this.ctx.currentTime+0.2);
    gn.gain.setValueAtTime(0.4,this.ctx.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.001,this.ctx.currentTime+0.3);
    o.connect(gn); gn.connect(this.ctx.destination);
    o.start(); o.stop(this.ctx.currentTime+0.3);
  },

  // ── Menu music (gentle ambient loop) ─────────────────────────────────────
  startMenuMusic(){
    if(!this.ctx||this.menuNodes) return;
    this.resume();
    const master=this.ctx.createGain();
    master.gain.value=this.vol.music*this.vol.master*0.5;
    master.connect(this.ctx.destination);

    // Slow pentatonic arp
    const notes=[261,311,392,466,523,622,784];
    let step=0;
    const playNote=()=>{
      if(!this.menuNodes) return;
      const o=this.ctx.createOscillator(); const g=this.ctx.createGain();
      o.type='sine'; o.frequency.value=notes[step%notes.length];
      g.gain.setValueAtTime(0.3,this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,this.ctx.currentTime+1.2);
      o.connect(g); g.connect(master); o.start(); o.stop(this.ctx.currentTime+1.2);
      step++;
    };
    const interval=setInterval(()=>{if(!this.menuNodes){clearInterval(interval);return;}playNote();},700);
    playNote();
    this.menuNodes={master,interval};
  },

  stopMenuMusic(){
    if(!this.menuNodes) return;
    clearInterval(this.menuNodes.interval);
    try{ this.menuNodes.master.gain.linearRampToValueAtTime(0,this.ctx.currentTime+0.5); }catch(e){}
    this.menuNodes=null;
  },

  // ── Game music (rhythmic loop) ────────────────────────────────────────────
  startGameMusic(){
    if(!this.ctx||this.gameNodes) return;
    this.resume();
    const master=this.ctx.createGain();
    master.gain.value=this.vol.music*this.vol.master*0.35;
    master.connect(this.ctx.destination);

    // Driving 8th-note bass pattern
    const bassNotes=[110,110,138,110,147,110,130,110];
    let beat=0;
    const playBeat=()=>{
      if(!this.gameNodes) return;
      const o=this.ctx.createOscillator(); const g=this.ctx.createGain();
      o.type='square'; o.frequency.value=bassNotes[beat%bassNotes.length];
      g.gain.setValueAtTime(0.25,this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,this.ctx.currentTime+0.22);
      o.connect(g); g.connect(master); o.start(); o.stop(this.ctx.currentTime+0.22);
      // Hi-hat on even beats
      if(beat%2===0){
        const buf=this.ctx.createBuffer(1,this.ctx.sampleRate*0.04,this.ctx.sampleRate);
        const dd=buf.getChannelData(0);
        for(let i=0;i<dd.length;i++) dd[i]=(Math.random()*2-1)*Math.pow(1-i/dd.length,3);
        const s=this.ctx.createBufferSource(); s.buffer=buf;
        const f=this.ctx.createBiquadFilter(); f.type='highpass'; f.frequency.value=8000;
        const gg=this.ctx.createGain(); gg.gain.value=0.15;
        s.connect(f); f.connect(gg); gg.connect(master); s.start();
      }
      beat++;
    };
    const interval=setInterval(()=>{if(!this.gameNodes){clearInterval(interval);return;}playBeat();},250);
    playBeat();
    this.gameNodes={master,interval};
  },

  stopGameMusic(){
    if(!this.gameNodes) return;
    clearInterval(this.gameNodes.interval);
    try{ this.gameNodes.master.gain.linearRampToValueAtTime(0,this.ctx.currentTime+0.8); }catch(e){}
    this.gameNodes=null;
  },
};

// ── Loaders ────────────────────────────────────────────────────────────────────
async function loadSprites(){
  try{
    const data=await(await fetch('/api/sprites')).json();
    let p=Object.keys(data).length; if(!p){spritesReady=true;return;}
    for(const[k,b64] of Object.entries(data)){
      const img=new Image();
      img.onload=()=>{sprites[k]=img;if(--p===0)spritesReady=true;};
      img.onerror=()=>{if(--p===0)spritesReady=true;};
      img.src=b64;
    }
  }catch{spritesReady=true;}
}
async function loadMaps(){
  try{mapsMeta=await(await fetch('/api/maps')).json();}catch(e){console.warn(e);}
}

// ── Particles ─────────────────────────────────────────────────────────────────
function spawnSparks(x,y,impulse,count=10){
  const spd=Math.min(impulse*0.55,9);
  for(let i=0;i<count;i++){
    const ang=Math.random()*Math.PI*2, s=spd*(0.3+Math.random()*0.7);
    particles.push({x,y,vx:Math.cos(ang)*s,vy:Math.sin(ang)*s,
      life:1.,decay:0.035+Math.random()*0.04,
      size:1.5+Math.random()*3,
      color:`hsl(${30+Math.random()*40},90%,${60+Math.random()*30}%)`});
  }
}
function spawnPickupBurst(x,y,color){
  for(let i=0;i<16;i++){
    const ang=i/16*Math.PI*2;
    particles.push({x,y,vx:Math.cos(ang)*(2+Math.random()*4),vy:Math.sin(ang)*(2+Math.random()*4),
      life:1.,decay:0.028,size:3+Math.random()*3,color});
  }
}
function triggerShake(amp){shakeAmp=Math.min(amp,14);shakeDur=20;}
function updateParticles(){
  for(let i=particles.length-1;i>=0;i--){
    const p=particles[i]; p.x+=p.vx; p.y+=p.vy;
    p.vx*=0.87; p.vy*=0.87; p.life-=p.decay;
    if(p.life<=0) particles.splice(i,1);
  }
}
function drawParticles(){
  particles.forEach(p=>{
    ctx.save(); ctx.globalAlpha=p.life*p.life;
    ctx.fillStyle=p.color; ctx.shadowBlur=7; ctx.shadowColor=p.color;
    ctx.beginPath(); ctx.arc(p.x,p.y,p.size*p.life,0,Math.PI*2); ctx.fill();
    ctx.restore();
  });
}

// ── Smooth interpolation ───────────────────────────────────────────────────────
function initSmooth(pens){
  Object.entries(pens).forEach(([pid,pen])=>{
    smoothPens[pid]={x:pen.x,y:pen.y,angle:pen.angle||0};
  });
}
function lerpAngle(a,b,t){
  let d=b-a;
  while(d>Math.PI) d-=Math.PI*2;
  while(d<-Math.PI) d+=Math.PI*2;
  return a+d*t;
}
function updateSmooth(pens){
  if(!pens) return;
  const L=isSimulating?0.25:0.20;
  Object.entries(pens).forEach(([pid,pen])=>{
    if(!pen.alive) return;
    if(!smoothPens[pid]){smoothPens[pid]={x:pen.x,y:pen.y,angle:pen.angle||0};return;}
    const s=smoothPens[pid];
    s.x+=(pen.x-s.x)*L; s.y+=(pen.y-s.y)*L;
    s.angle=lerpAngle(s.angle,pen.angle||0,L);
  });
}

// ── Trails ─────────────────────────────────────────────────────────────────────
function genTrails(oldPens,newPens){
  if(!oldPens||!newPens) return;
  Object.entries(newPens).forEach(([pid,pen])=>{
    if(!pen.alive) return;
    const old=oldPens[pid]; if(!old) return;
    if(Math.hypot(pen.x-old.x,pen.y-old.y)<0.8) return;
    if(trails.length>400) trails.splice(0,50);
    trails.push({x:old.x,y:old.y,angle:old.angle||0,
      width:pen.width,height:pen.height,color:pen.color,type:pen.type,life:1.});
  });
}

// ── Background builder ─────────────────────────────────────────────────────────
function buildBg(mapKey){
  if(bgCache[mapKey]) return bgCache[mapKey];
  const off=document.createElement('canvas');
  off.width=canvas.width; off.height=canvas.height;
  const oc=off.getContext('2d');
  const{left:L,right:R,top:T,bottom:B}=TABLE; const W=R-L,H=B-T;

  // Outer shadow
  oc.fillStyle='#111'; oc.beginPath(); oc.roundRect(L-14,T-14,W+28,H+28,22); oc.fill();

  oc.save(); oc.beginPath(); oc.roundRect(L,T,W,H,12); oc.clip();

  if(mapKey==='classic'){
    oc.fillStyle='#7a5230'; oc.fillRect(L,T,W,H);
    for(let i=0;i<55;i++){
      const y=T+i*9+Math.random()*4;
      oc.beginPath(); oc.moveTo(L,y);
      for(let x=L;x<R;x+=8) oc.lineTo(x,y+(Math.random()-.5)*2.5);
      oc.strokeStyle=`rgba(0,0,0,${.022+Math.random()*.055})`; oc.lineWidth=.6+Math.random(); oc.stroke();
    }
    for(let k=0;k<5;k++){
      const kx=L+30+Math.random()*(W-60),ky=T+20+Math.random()*(H-40);
      const g=oc.createRadialGradient(kx,ky,2,kx,ky,18);
      g.addColorStop(0,'rgba(50,25,8,.22)'); g.addColorStop(1,'rgba(50,25,8,0)');
      oc.fillStyle=g; oc.fillRect(kx-20,ky-20,40,40);
    }
  } else if(mapKey==='ice'){
    const ig=oc.createLinearGradient(L,T,R,B);
    ig.addColorStop(0,'#d8f0ff'); ig.addColorStop(.5,'#b5e5f5'); ig.addColorStop(1,'#c8edff');
    oc.fillStyle=ig; oc.fillRect(L,T,W,H);
    oc.strokeStyle='rgba(100,185,225,.4)'; oc.lineWidth=.8;
    for(let c=0;c<22;c++){
      let cx2=L+Math.random()*W,cy2=T+Math.random()*H; oc.beginPath(); oc.moveTo(cx2,cy2);
      for(let s=0;s<6;s++){cx2+=(Math.random()-.5)*35;cy2+=(Math.random()-.5)*25;oc.lineTo(cx2,cy2);}
      oc.stroke();
    }
    for(let d=0;d<70;d++){
      oc.fillStyle=`rgba(255,255,255,${.2+Math.random()*.5})`;
      oc.beginPath(); oc.arc(L+Math.random()*W,T+Math.random()*H,.5+Math.random()*1.4,0,Math.PI*2); oc.fill();
    }
  } else if(mapKey==='sandpaper'){
    oc.fillStyle='#c2a060'; oc.fillRect(L,T,W,H);
    for(let n=0;n<5500;n++){
      const px=L+Math.random()*W,py=T+Math.random()*H;
      oc.fillStyle=Math.random()>.58?`rgba(255,215,130,${.1+Math.random()*.22})`:`rgba(75,45,8,${.06+Math.random()*.18})`;
      oc.fillRect(px,py,1+Math.random()*2,1+Math.random()*2);
    }
  } else if(mapKey==='portal'){
    const pg=oc.createRadialGradient((L+R)/2,(T+B)/2,40,(L+R)/2,(T+B)/2,320);
    pg.addColorStop(0,'#1a0a2e'); pg.addColorStop(1,'#0a0015');
    oc.fillStyle=pg; oc.fillRect(L,T,W,H);
    for(let s=0;s<140;s++){
      oc.fillStyle=`rgba(255,255,255,${.07+Math.random()*.4})`;
      oc.beginPath(); oc.arc(L+Math.random()*W,T+Math.random()*H,Math.random()*1.3,0,Math.PI*2); oc.fill();
    }
    const hr=28; oc.strokeStyle='rgba(168,85,247,.06)'; oc.lineWidth=1;
    for(let row=-1;row<H/hr+2;row++) for(let col=-1;col<W/(hr*1.732)+2;col++){
      const hx=L+col*hr*1.732+(row%2)*hr*.866,hy=T+row*hr*1.5;
      oc.beginPath();
      for(let i=0;i<6;i++){const a=Math.PI/180*60*i-Math.PI/6;i===0?oc.moveTo(hx+hr*.82*Math.cos(a),hy+hr*.82*Math.sin(a)):oc.lineTo(hx+hr*.82*Math.cos(a),hy+hr*.82*Math.sin(a));}
      oc.closePath(); oc.stroke();
    }
  } else if(mapKey==='bumper'){
    // Arcade-style floor
    const cg=oc.createLinearGradient(L,T,L,B);
    cg.addColorStop(0,'#1a1a2e'); cg.addColorStop(1,'#16213e');
    oc.fillStyle=cg; oc.fillRect(L,T,W,H);
    // Grid lines
    oc.strokeStyle='rgba(255,255,255,.04)'; oc.lineWidth=1;
    for(let x=L;x<R;x+=40){oc.beginPath();oc.moveTo(x,T);oc.lineTo(x,B);oc.stroke();}
    for(let y=T;y<B;y+=40){oc.beginPath();oc.moveTo(L,y);oc.lineTo(R,y);oc.stroke();}
  }

  // Vignette
  const vig=oc.createRadialGradient((L+R)/2,(T+B)/2,80,(L+R)/2,(T+B)/2,370);
  vig.addColorStop(0,'rgba(0,0,0,0)');
  vig.addColorStop(1,mapKey==='ice'?'rgba(0,40,70,.14)':'rgba(0,0,0,.30)');
  oc.fillStyle=vig; oc.fillRect(L,T,W,H);
  oc.restore();

  // Table edge
  const edgeClr=mapKey==='portal'?'#a855f7':mapKey==='ice'?'#7dd3fc':mapKey==='sandpaper'?'#d97706':mapKey==='bumper'?'#38bdf8':'#c8a060';
  oc.strokeStyle='rgba(0,0,0,.7)'; oc.lineWidth=12;
  oc.beginPath(); oc.roundRect(L,T,W,H,12); oc.stroke();
  oc.strokeStyle=edgeClr; oc.lineWidth=4;
  oc.beginPath(); oc.roundRect(L,T,W,H,12); oc.stroke();
  oc.strokeStyle='rgba(255,255,255,.4)'; oc.lineWidth=1.5;
  oc.beginPath(); oc.roundRect(L+3,T+3,W-6,H-6,9); oc.stroke();
  // Corner dots
  [[L,T],[R,T],[R,B],[L,B]].forEach(([x,y])=>{
    oc.fillStyle='rgba(0,0,0,.5)'; oc.beginPath(); oc.arc(x,y,8,0,Math.PI*2); oc.fill();
    oc.fillStyle=edgeClr; oc.beginPath(); oc.arc(x,y,5.5,0,Math.PI*2); oc.fill();
  });

  bgCache[mapKey]=off; return off;
}

// ── Portal drawing ─────────────────────────────────────────────────────────────
function drawPortals(portals){
  if(!portals?.length) return;
  portals.forEach(p=>{
    drawPortalMouth(p.ax,p.ay,p.radius,p.color||'#a855f7', 1);
    drawPortalMouth(p.bx,p.by,p.radius,p.color2||p.color||'#f97316',-1);
  });
}
function drawPortalMouth(x,y,r,color,spin){
  ctx.save(); ctx.translate(x,y);
  const g1=ctx.createRadialGradient(0,0,0,0,0,r*2.2);
  g1.addColorStop(0,hexA(color,.28)); g1.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=g1; ctx.beginPath(); ctx.arc(0,0,r*2.2,0,Math.PI*2); ctx.fill();
  ctx.rotate(glowT.v*spin*1.8);
  ctx.strokeStyle=color; ctx.lineWidth=2.8; ctx.setLineDash([9,7]);
  ctx.globalAlpha=0.8; ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.stroke();
  ctx.setLineDash([]);
  const pulse=.5+.5*Math.sin(glowT.v*2.5);
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.globalAlpha=.3+.25*pulse;
  ctx.beginPath(); ctx.arc(0,0,r*.52,0,Math.PI*2); ctx.stroke();
  ctx.restore();
}
function hexA(hex,a){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Bumper drawing ─────────────────────────────────────────────────────────────
function drawBumpers(bumpers){
  if(!bumpers?.length) return;
  bumpers.forEach(b=>{
    const pulse=.5+.5*Math.sin(glowT.v*2+b.x*.01);
    ctx.save();
    // Outer glow
    ctx.shadowBlur=16*pulse; ctx.shadowColor='#38bdf8';
    // Ring
    ctx.strokeStyle='#38bdf8'; ctx.lineWidth=3;
    ctx.globalAlpha=.7+.3*pulse;
    ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,Math.PI*2); ctx.stroke();
    // Fill
    const g=ctx.createRadialGradient(b.x,b.y,0,b.x,b.y,b.r);
    g.addColorStop(0,'rgba(56,189,248,.25)'); g.addColorStop(1,'rgba(56,189,248,.05)');
    ctx.fillStyle=g; ctx.globalAlpha=1;
    ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,Math.PI*2); ctx.fill();
    ctx.restore();
  });
}

// ── Powerup drawing ────────────────────────────────────────────────────────────
function drawPowerups(powerups){
  if(!powerups?.length) return;
  powerups.forEach(pu=>{
    const bob=Math.sin(glowT.v*2)*3;
    const x=pu.x, y=pu.y+bob;
    const pulse=.6+.4*Math.sin(glowT.v*3);
    const color=pu.color||'#facc15';
    ctx.save();
    ctx.shadowBlur=18*pulse; ctx.shadowColor=color;
    ctx.fillStyle='rgba(0,0,0,.6)';
    ctx.beginPath(); ctx.arc(x,y,20,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.globalAlpha=.7+.3*pulse;
    ctx.beginPath(); ctx.arc(x,y,20,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha=1; ctx.shadowBlur=0;
    ctx.font='17px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(pu.emoji||'⚡',x,y);
    // Lifetime arc
    const lt=Math.max(0,pu.lifetime||0);
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.globalAlpha=.5;
    ctx.beginPath();
    ctx.arc(x,y,23,-Math.PI/2,-Math.PI/2+Math.PI*2*(lt/360));
    ctx.stroke();
    ctx.restore();
  });
}

// ── Map ambient effects ────────────────────────────────────────────────────────
function drawIceShimmer(){
  shimmerT+=0.022;
  const{left:L,right:R,top:T,bottom:B}=TABLE;
  for(let i=0;i<5;i++){
    const x=L+(R-L)*((Math.sin(shimmerT+i*1.4)*.5+.5));
    const y=T+(B-T)*((Math.cos(shimmerT*.7+i*1.1)*.5+.5));
    const g=ctx.createRadialGradient(x,y,0,x,y,48);
    g.addColorStop(0,'rgba(180,230,255,.09)'); g.addColorStop(1,'rgba(180,230,255,0)');
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,48,0,Math.PI*2); ctx.fill();
  }
}

// ── Edge warning ───────────────────────────────────────────────────────────────
function drawEdgeWarning(){
  if(!gameState?.pens) return;
  const{left:L,right:R,top:T,bottom:B}=TABLE;
  Object.entries(gameState.pens).forEach(([pid,pen])=>{
    if(!pen.alive) return;
    const s=smoothPens[pid]||{x:pen.x,y:pen.y,angle:pen.angle||0};
    const hw=pen.width/2,hh=pen.height/2;
    const cosA=Math.abs(Math.cos(s.angle)),sinA=Math.abs(Math.sin(s.angle));
    const extX=hw*cosA+hh*sinA, extY=hw*sinA+hh*cosA;
    const overR=(s.x+extX)-R,overL=L-(s.x-extX);
    const overB=(s.y+extY)-B,overT=T-(s.y-extY);
    const maxOver=Math.max(overR,overL,overB,overT);
    if(maxOver<=0) return;
    const danger=Math.min(maxOver/(Math.min(extX,extY)*0.5),1.);
    if(danger<=0.05) return;
    const pulse=.55+.45*Math.sin(glowT.v*5);
    ctx.save();
    ctx.strokeStyle=`rgba(255,${Math.round(60*(1-danger))},60,${danger*pulse*.85})`;
    ctx.lineWidth=3+danger*4; ctx.shadowBlur=12*danger; ctx.shadowColor=`rgba(255,40,40,${danger*pulse})`;
    ctx.beginPath(); ctx.ellipse(s.x,s.y,extX+7,extY+7,s.angle,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  });
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render(){
  glowT.v+=0.05;
  if(shakeDur>0){shakeX=(Math.random()-.5)*shakeAmp*(shakeDur/20);shakeY=(Math.random()-.5)*shakeAmp*(shakeDur/20);shakeDur--;}
  else{shakeX=0;shakeY=0;}

  ctx.save(); ctx.translate(shakeX,shakeY);
  ctx.clearRect(-20,-20,canvas.width+40,canvas.height+40);
  ctx.drawImage(buildBg(currentMap),0,0);

  if(currentMap==='portal'&&gameState?.portals) drawPortals(gameState.portals);
  if(currentMap==='bumper'&&gameState?.bumpers)  drawBumpers(gameState.bumpers);
  if(currentMap==='ice') drawIceShimmer();

  drawEdgeWarning();
  if(gameState?.powerups) drawPowerups(gameState.powerups);

  if(gameState?.pens) updateSmooth(gameState.pens);

  for(let i=trails.length-1;i>=0;i--){
    trails[i].life-=0.048; if(trails[i].life<=0){trails.splice(i,1);continue;}
    drawTrail(trails[i]);
  }

  if(gameState?.pens)
    Object.entries(gameState.pens).forEach(([pid,pen])=>
      drawPen(pen,pid,pid===gameState.currentTurn&&!isSimulating));

  updateParticles(); drawParticles();
  drawAim();
  ctx.restore();
}

function drawTrail(t){
  ctx.save(); ctx.globalAlpha=t.life*.2;
  ctx.translate(t.x,t.y); ctx.rotate(t.angle);
  const spr=sprites[t.type];
  if(spr){ctx.drawImage(spr,-t.width/2,-t.height/2,t.width,t.height);}
  else{ctx.fillStyle=t.color;ctx.beginPath();ctx.roundRect(-t.width/2,-t.height/2,t.width,t.height,4);ctx.fill();}
  ctx.restore();
}

function drawPen(pen,pid,isActive){
  if(!pen.alive) return;
  const s=smoothPens[pid]||{x:pen.x,y:pen.y,angle:pen.angle||0};
  const spr=sprites[pen.type];
  ctx.save(); ctx.translate(s.x,s.y); ctx.rotate(s.angle);
  if(isActive){const p=.5+.5*Math.sin(glowT.v*3);ctx.shadowBlur=22+p*20;ctx.shadowColor='#f0c040';}
  else{ctx.shadowBlur=10;ctx.shadowColor='rgba(0,0,0,.75)';}

  if(spr&&spritesReady){
    ctx.drawImage(spr,-pen.width/2,-pen.height/2,pen.width,pen.height);
  } else {
    const gr=ctx.createLinearGradient(-pen.width/2,-pen.height/2,pen.width/2,pen.height/2);
    gr.addColorStop(0,lighten(pen.color,55)); gr.addColorStop(.5,pen.color); gr.addColorStop(1,darken(pen.color,38));
    ctx.fillStyle=gr; ctx.beginPath(); ctx.roundRect(-pen.width/2,-pen.height/2,pen.width,pen.height,6); ctx.fill();
    const gl=ctx.createLinearGradient(-pen.width/2,-pen.height/2,pen.width/2,0);
    gl.addColorStop(0,'rgba(255,255,255,.22)'); gl.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=gl; ctx.beginPath(); ctx.roundRect(-pen.width/2,-pen.height/2,pen.width,pen.height/2,6); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.roundRect(-pen.width/2,-pen.height/2,pen.width,pen.height,6); ctx.stroke();
  }

  // Powerup icon on active powerup
  if(pen.active_powerup&&gameState?.powerupTypes){
    const pt=gameState.powerupTypes[pen.active_powerup];
    if(pt){
      ctx.shadowBlur=0; ctx.font='13px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(pt.emoji,pen.width/2+10,-pen.height/2+8);
    }
  }
  ctx.restore();

  // Label
  if(gameState?.players?.[pid]){
    const name=gameState.players[pid].name;
    const labelY=s.y-pen.height/2-10;
    ctx.save();
    ctx.font='bold 11px "DM Mono",monospace'; ctx.textAlign='center'; ctx.textBaseline='bottom';
    const tw=ctx.measureText(name.slice(0,9)).width;
    ctx.fillStyle=isActive?'rgba(240,192,64,.28)':'rgba(0,0,0,.52)';
    ctx.beginPath(); ctx.roundRect(s.x-tw/2-7,labelY-15,tw+14,17,9); ctx.fill();
    ctx.fillStyle=isActive?'#f0c040':'rgba(255,255,255,.9)';
    ctx.fillText(name.slice(0,9),s.x,labelY);
    const w=roundWins[pid]||0;
    for(let i=0;i<w;i++){ctx.fillStyle='#f0c040';ctx.beginPath();ctx.arc(s.x+tw/2+12+i*11,labelY-8,3.5,0,Math.PI*2);ctx.fill();}
    ctx.restore();
  }
}

function drawAim(){
  if(!dragState?.active||!gameState||!isMyTurn()||isSimulating) return;
  const pen=gameState.pens?.[myPlayerId]; if(!pen?.alive) return;
  const s=smoothPens[myPlayerId]||{x:pen.x,y:pen.y};
  const{startX,startY,currentX,currentY}=dragState;
  const ddx=currentX-startX,ddy=currentY-startY;
  const dlen=Math.hypot(ddx,ddy); if(dlen<4) return;
  const sdx=-ddx/dlen,sdy=-ddy/dlen;
  const power=Math.min(dlen*.10,MAX_POWER);
  const aLen=65+power*10;
  const ax=s.x+sdx*aLen,ay=s.y+sdy*aLen;
  ctx.save();
  ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=2.5; ctx.setLineDash([8,5]);
  ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(ax,ay); ctx.stroke(); ctx.setLineDash([]);
  const ang=Math.atan2(sdy,sdx);
  ctx.fillStyle='white'; ctx.beginPath();
  ctx.moveTo(ax,ay); ctx.lineTo(ax-14*Math.cos(ang-.42),ay-14*Math.sin(ang-.42));
  ctx.lineTo(ax-14*Math.cos(ang+.42),ay-14*Math.sin(ang+.42)); ctx.closePath(); ctx.fill();
  ctx.strokeStyle='rgba(255,77,109,.55)'; ctx.lineWidth=2; ctx.setLineDash([5,5]);
  ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(currentX,currentY); ctx.stroke(); ctx.setLineDash([]);
  // Power bar
  const hue=120-power*13;
  const bW=260,bH=10,bX=canvas.width/2-bW/2,bY=canvas.height-22;
  ctx.globalAlpha=1;
  ctx.fillStyle='rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect(bX-3,bY-3,bW+6,bH+6,6); ctx.fill();
  const fW=(power/MAX_POWER)*bW;
  const bg=ctx.createLinearGradient(bX,0,bX+fW,0);
  bg.addColorStop(0,'#22c55e'); bg.addColorStop(.6,`hsl(${hue},80%,55%)`); bg.addColorStop(1,'#ef4444');
  ctx.fillStyle=bg; ctx.beginPath(); ctx.roundRect(bX,bY,fW,bH,4); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.75)'; ctx.font='11px "DM Mono",monospace';
  ctx.textAlign='center'; ctx.textBaseline='bottom';
  ctx.fillText(`POWER  ${power.toFixed(1)} / ${MAX_POWER}`,canvas.width/2,bY-7);
  // Boost indicator
  if(gameState?.pens?.[myPlayerId]?.active_powerup==='speed_boost'){
    ctx.fillStyle='#facc15'; ctx.font='bold 12px "DM Mono",monospace';
    ctx.fillText('⚡ SPEED BOOST ACTIVE',canvas.width/2,bY-22);
  }
  ctx.restore();
}

function startLoop(){
  if(animFrame) cancelAnimationFrame(animFrame);
  const loop=()=>{render();animFrame=requestAnimationFrame(loop);}; loop();
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function lighten(h,a){return adjColor(h, a);} function darken(h,a){return adjColor(h,-a);}
function adjColor(hex,a){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgb(${clamp(r+a)},${clamp(g+a)},${clamp(b+a)})`;
}
function clamp(v){return Math.max(0,Math.min(255,v));}

// ── Socket.IO ──────────────────────────────────────────────────────────────────
function connectSocket(){
  socket=io();

  socket.on('room_created',d=>{
    myPlayerId=d.playerId; myRoomCode=d.code; isHost=true;
    document.getElementById('lobby-code').textContent=d.code;
    document.getElementById('btn-start').disabled=false;
    document.getElementById('host-hint').textContent='You are the host — share the code!';
    currentMap=d.chosenMap||'classic';
    showScreen('lobby'); buildPenGrid(); setupMapCards(true,currentMap);
    Audio.stopMenuMusic(); Audio.startMenuMusic();
  });

  socket.on('room_joined',d=>{
    myPlayerId=d.playerId; myRoomCode=d.code; isHost=false;
    document.getElementById('lobby-code').textContent=d.code;
    document.getElementById('btn-start').disabled=true;
    document.getElementById('host-hint').textContent='Waiting for host to start…';
    currentMap=d.chosenMap||'classic';
    showScreen('lobby'); buildPenGrid(); setupMapCards(false,currentMap);
    Audio.stopMenuMusic(); Audio.startMenuMusic();
  });

  socket.on('player_joined',d=>{updateLobbyPlayers(d.players,null);toast(`${d.name} joined!`);});
  socket.on('player_left',()=>toast('A player disconnected'));

  socket.on('pen_selected',d=>{
    const el=document.querySelector(`#player-list li[data-pid="${d.playerId}"] .pen-badge`);
    if(el) el.textContent=PEN_TYPES[d.penType]?.emoji??'?';
  });

  socket.on('map_selected',d=>{
    currentMap=d.mapKey;
    document.querySelectorAll('.map-card').forEach(c=>c.classList.toggle('selected',c.dataset.key===d.mapKey));
    toast(`Map: ${d.mapName||d.mapKey}`);
  });

  socket.on('round_started',state=>{
    gameState=state; isSimulating=false;
    currentMap=state.map; currentRound=state.round; roundWins=state.roundWins||{};
    document.getElementById('overlay-round').classList.add('hidden');
    document.body.className=`map-${currentMap}`;
    initSmooth(state.pens);
    showScreen('game');
    Audio.stopMenuMusic(); Audio.startGameMusic();
    if(!animFrame) startLoop();
    updateHUD(); updateBanner();
    setMessage(isMyTurn()?'🎯 Your turn! Drag backward to aim.':`${getCurrentName()}'s turn…`);
  });

  socket.on('game_state_update',state=>{
    if(state.collisionEvents?.length){
      state.collisionEvents.forEach(ev=>{
        spawnSparks(ev.x,ev.y,ev.impulse,Math.ceil(ev.impulse*1.1));
        if(ev.impulse>3.5) triggerShake(ev.impulse*.45);
        Audio.playCollision(ev.impulse);
      });
    }
    if(state.powerupEvents?.length){
      state.powerupEvents.forEach(ev=>{
        const pt=state.powerupTypes?.[ev.puType];
        spawnPickupBurst(ev.x,ev.y,pt?.color||'#facc15');
        Audio.playPickup();
        if(ev.pid===myPlayerId) toast(`Got ${pt?.emoji||'⚡'} ${pt?.name||'Powerup'}!`);
      });
    }
    // Elimination death burst
    const prevElim=gameState?.eliminated||[];
    state.eliminated?.forEach(pid=>{
      if(!prevElim.includes(pid)){
        const pen=state.pens?.[pid];
        if(pen){spawnSparks(pen.x,pen.y,14,30); Audio.playElimination();}
      }
    });
    if(gameState) genTrails(gameState.pens,state.pens);
    gameState=state; isSimulating=state.simulating;
    roundWins=state.roundWins||roundWins; currentRound=state.round||currentRound;
    updateHUD(); updateBanner();
    const skipBtn=document.getElementById('btn-skip');
    if(isSimulating&&state.currentTurn===myPlayerId) skipBtn.classList.remove('hidden');
    else skipBtn.classList.add('hidden');
    if(!isSimulating) setMessage(isMyTurn()?'🎯 Your turn!':`${getCurrentName()}'s turn…`);
  });

  socket.on('round_over',d=>{
    roundWins=d.roundWins||roundWins;
    showRoundOverlay(d.roundWinnerName,d.roundWins,d.nextRound);
    Audio.playRoundWin();
  });
  socket.on('match_over',d=>{
    roundWins=d.roundWins||roundWins;
    showMatchOverlay(d.matchWinnerName,d.roundWins);
    Audio.stopGameMusic(); Audio.playRoundWin();
  });

  socket.on('lobby_reset',d=>{
    document.getElementById('overlay-match').classList.add('hidden');
    document.getElementById('overlay-round').classList.add('hidden');
    cancelAnimationFrame(animFrame); animFrame=null;
    gameState=null; currentRound=1; roundWins={};
    document.body.className='';
    Audio.stopGameMusic(); Audio.startMenuMusic();
    updateLobbyPlayers(d.players,d.host);
    setupMapCards(isHost,currentMap);
    showScreen('lobby');
  });

  socket.on('error',d=>toast('⚠ '+d.msg));
}

// ── Overlays ───────────────────────────────────────────────────────────────────
function showRoundOverlay(winnerName,wins,nextRound){
  document.getElementById('round-emoji').textContent=winnerName?'🎯':'🤝';
  document.getElementById('round-title').textContent=`Round ${currentRound} Over!`;
  document.getElementById('round-winner-name').textContent=
    winnerName?`${winnerName} wins this round!`:'No survivor — draw!';
  document.getElementById('next-round-hint').textContent=
    nextRound?`Round ${nextRound} starts in 3.5 s…`:'';
  const sd=document.getElementById('round-score-display'); sd.innerHTML='';
  if(gameState?.players) Object.entries(gameState.players).forEach(([pid,p])=>{
    const w=wins[pid]||0;
    const dots=Array.from({length:WIN_ROUNDS},(_,i)=>`<div class="sb-dot${i<w?' filled':''}"></div>`).join('');
    const div=document.createElement('div'); div.className='score-block';
    div.innerHTML=`<div class="sb-name">${p.name.slice(0,8)}</div><div class="sb-dots">${dots}</div>`;
    sd.appendChild(div);
  });
  document.getElementById('overlay-round').classList.remove('hidden');
}
function showMatchOverlay(winnerName,wins){
  document.getElementById('overlay-round').classList.add('hidden');
  const myName=gameState?.players?.[myPlayerId]?.name;
  document.getElementById('match-winner-name').textContent=winnerName===myName?'🎉 You win the match!':`${winnerName} wins!`;
  const fs=document.getElementById('final-scores'); fs.innerHTML='';
  if(gameState?.players) Object.entries(gameState.players).forEach(([pid,p])=>{
    const div=document.createElement('div');
    div.className='final-score-item'+(wins[pid]>=WIN_ROUNDS?' winner':'');
    div.textContent=`${p.name}: ${wins[pid]||0} win${wins[pid]===1?'':'s'}`;
    fs.appendChild(div);
  });
  document.getElementById('overlay-match').classList.remove('hidden');
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
const showScreen=name=>{
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
};
const isMyTurn=()=>gameState&&gameState.currentTurn===myPlayerId;
const getCurrentName=()=>gameState?.players?.[gameState.currentTurn]?.name??'—';
const setMessage=msg=>{document.getElementById('game-message').textContent=msg;};
function toast(msg,dur=2800){
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'),dur);
}

function updateHUD(){
  if(!gameState) return;
  document.getElementById('hud-turn-name').textContent=getCurrentName();
  document.getElementById('hud-map-tag').textContent=`${mapsMeta[currentMap]?.emoji??''} ${mapsMeta[currentMap]?.name??currentMap}`;
  // Active powerup
  const myPen=gameState.pens?.[myPlayerId];
  const puEl=document.getElementById('hud-powerup');
  if(puEl&&myPen?.active_powerup){
    const pt=gameState.powerupTypes?.[myPen.active_powerup];
    puEl.textContent=pt?`${pt.emoji} ${pt.name}`:''; puEl.style.display='block';
  } else if(puEl) puEl.style.display='none';
  const ul=document.getElementById('hud-player-list'); ul.innerHTML='';
  (gameState.turnOrder||[]).forEach(pid=>{
    const pi=gameState.players?.[pid]; const pen=gameState.pens?.[pid]; if(!pi) return;
    const li=document.createElement('li');
    if(!pen?.alive) li.classList.add('eliminated');
    if(pid===gameState.currentTurn) li.classList.add('your-turn');
    const pt=PEN_TYPES[pi.penType];
    li.innerHTML=`<span>${pt?.emoji??'?'}</span><span>${pi.name.slice(0,10)}${pid===myPlayerId?' (you)':''}</span>`;
    ul.appendChild(li);
  });
}

function updateBanner(){
  document.getElementById('banner-round').textContent=`Round ${currentRound}`;
  document.getElementById('banner-map').textContent=`${mapsMeta[currentMap]?.emoji??''} ${mapsMeta[currentMap]?.name??currentMap}`;
  const row=document.getElementById('score-row'); row.innerHTML='';
  if(!gameState?.players) return;
  Object.entries(gameState.players).forEach(([pid,p])=>{
    const w=roundWins[pid]||0;
    const dots=Array.from({length:WIN_ROUNDS},(_,i)=>`<div class="win-dot${i<w?' filled':''}"></div>`).join('');
    const div=document.createElement('div'); div.className='score-pip';
    div.innerHTML=`<span>${p.name.slice(0,6)}</span><div class="wins">${dots}</div>`;
    row.appendChild(div);
  });
}

function updateLobbyPlayers(players,hostId){
  const ul=document.getElementById('player-list');
  const cnt=document.getElementById('player-count');
  ul.innerHTML=''; const entries=Object.entries(players);
  cnt.textContent=`${entries.length}/6`;
  entries.forEach(([pid,p])=>{
    const pt=PEN_TYPES[p.penType]; const li=document.createElement('li'); li.dataset.pid=pid;
    li.innerHTML=`<span class="pen-badge">${pt?.emoji??'?'}</span>
      <span class="player-name">${p.name}${pid===myPlayerId?' (you)':''}</span>
      ${pid===hostId?'<span class="player-host">HOST</span>':''}`;
    ul.appendChild(li);
  });
}

function setupMapCards(asHost,selectedKey){
  const grid=document.getElementById('map-grid'); grid.innerHTML='';
  if(Object.keys(mapsMeta).length===0){setTimeout(()=>setupMapCards(asHost,selectedKey),300);return;}
  const sel=selectedKey||currentMap||'classic';
  Object.entries(mapsMeta).forEach(([key,m])=>{
    const card=document.createElement('div');
    card.className='map-card'+(asHost?' host-control':'')+(key===sel?' selected':'');
    card.dataset.key=key;
    card.innerHTML=`<div class="map-card-header"><span class="map-card-emoji">${m.emoji}</span><span class="map-card-name">${m.name}</span></div><div class="map-card-desc">${m.desc}</div>`;
    if(asHost) card.addEventListener('click',()=>{
      currentMap=key;
      document.querySelectorAll('.map-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      socket.emit('select_map',{mapKey:key});
    });
    grid.appendChild(card);
  });
}

function buildPenGrid(){
  const grid=document.getElementById('pen-grid'); grid.innerHTML='';
  Object.entries(PEN_TYPES).forEach(([key,pt])=>{
    const card=document.createElement('div'); card.className='pen-card'; card.dataset.key=key;
    const preview=sprites[key]?`<img src="${sprites[key].src}" alt="${pt.name}" class="pen-sprite-preview">`:`<span class="pen-card-emoji">${pt.emoji}</span>`;
    card.innerHTML=`${preview}<span class="pen-card-name">${pt.name}</span><span class="pen-card-stats">⚖${pt.weight} 🛡${pt.defense}</span><div class="pen-card-swatch" style="background:${pt.color}"></div>`;
    card.addEventListener('click',()=>{
      document.querySelectorAll('.pen-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected'); socket.emit('select_pen',{penType:key});
    });
    grid.appendChild(card);
  });
  grid.querySelector('.pen-card')?.classList.add('selected');
}

// ── Input ──────────────────────────────────────────────────────────────────────
function coords(e){
  const rect=canvas.getBoundingClientRect();
  const sx=canvas.width/rect.width,sy=canvas.height/rect.height;
  const src=e.touches?e.touches[0]:e;
  return{x:(src.clientX-rect.left)*sx,y:(src.clientY-rect.top)*sy};
}
function onDown(e){
  e.preventDefault(); Audio.resume();
  if(!isMyTurn()||isSimulating||!gameState) return;
  const pen=gameState.pens?.[myPlayerId]; if(!pen?.alive) return;
  const{x,y}=coords(e); dragState={startX:x,startY:y,currentX:x,currentY:y,active:true};
}
function onMove(e){e.preventDefault();if(!dragState?.active)return;const{x,y}=coords(e);dragState.currentX=x;dragState.currentY=y;}
function onUp(e){
  e.preventDefault(); if(!dragState?.active)return;
  const{startX,startY,currentX,currentY}=dragState; dragState=null;
  if(!isMyTurn()||isSimulating||!gameState) return;
  const ddx=currentX-startX,ddy=currentY-startY;
  const dlen=Math.hypot(ddx,ddy); if(dlen<10)return;
  const dx=-ddx/dlen,dy=-ddy/dlen;
  const power=Math.min(dlen*.10,MAX_POWER);
  Audio.playShoot(power);
  socket.emit('shoot',{dx,dy,power});
  isSimulating=true; setMessage('Physics running…');
}
canvas.addEventListener('mousedown',onDown,{passive:false});
canvas.addEventListener('mousemove',onMove,{passive:false});
canvas.addEventListener('mouseup',  onUp,  {passive:false});
canvas.addEventListener('mouseleave',onUp, {passive:false});
canvas.addEventListener('touchstart', onDown,{passive:false});
canvas.addEventListener('touchmove',  onMove,{passive:false});
canvas.addEventListener('touchend',   onUp,  {passive:false});
canvas.addEventListener('touchcancel',onUp,  {passive:false});

// ── Buttons ────────────────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click',()=>{
  const name=document.getElementById('input-name').value.trim()||'Player';
  Audio.init(); Audio.startMenuMusic();
  Promise.all([loadSprites(),loadMaps()]).then(()=>socket.emit('create_room',{name}));
});
document.getElementById('btn-join').addEventListener('click',()=>{
  const name=document.getElementById('input-name').value.trim()||'Player';
  const code=document.getElementById('input-code').value.trim().toUpperCase();
  if(!code||code.length!==4){toast('Enter a 4-letter room code');return;}
  Audio.init(); Audio.startMenuMusic();
  Promise.all([loadSprites(),loadMaps()]).then(()=>socket.emit('join_room',{name,code}));
});
document.getElementById('input-code').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-join').click();});
document.getElementById('input-name').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-create').click();});
document.getElementById('btn-copy-code').addEventListener('click',()=>{navigator.clipboard.writeText(myRoomCode||'').then(()=>toast('Room code copied!'));});
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
  Audio.stopGameMusic(); Audio.startMenuMusic();
  showScreen('menu');
});

// ── Boot ───────────────────────────────────────────────────────────────────────
connectSocket();
