"""
PenFight Arena – Server v8
- Random bumper placement & size per round
- Random portal positions per round
- Fixed ice friction (much less slippery)
- Working powerups (speed_boost, heavy, ghost, shield, magnet)
- 10 pen types, 5 maps, best-of-3, ngrok
"""
import os, math, random, string, threading, base64
from flask import Flask, send_from_directory, request as sio_request, jsonify
from flask_socketio import SocketIO, emit, join_room as sio_join_room

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__,
            static_folder=os.path.join(BASE_DIR,'static'),
            static_url_path='/static',
            template_folder=BASE_DIR)
app.config['SECRET_KEY'] = 'penfight_v8'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

TL, TR, TT, TB = 60, 740, 60, 540
TW, TH = TR-TL, TB-TT

# ── Maps (portals/bumpers generated fresh each round) ──────────────────────────
MAPS = {
    'classic':    {'name':'Classic Table', 'desc':'Balanced wood surface.',
                   'emoji':'🪵','bg':'wood',
                   'friction_linear':0.968,'friction_angular':0.940,
                   'restitution':0.50,'power_scale':0.95,'portals':[],'bumpers':[]},
    'ice':        {'name':'Ice Rink',      'desc':'Low friction – pens glide longer.',
                   'emoji':'🧊','bg':'ice',
                   'friction_linear':0.984,'friction_angular':0.972,   # FIXED: was 0.9985 (too slippery)
                   'restitution':0.60,'power_scale':0.70,'portals':[],'bumpers':[]},
    'sandpaper':  {'name':'Sandpaper',     'desc':'Max grip – stops fast.',
                   'emoji':'📄','bg':'sand',
                   'friction_linear':0.905,'friction_angular':0.840,
                   'restitution':0.22,'power_scale':1.20,'portals':[],'bumpers':[]},
    'portal':     {'name':'Portal Maze',   'desc':'Portals spawn randomly each round!',
                   'emoji':'🌀','bg':'portal',
                   'friction_linear':0.970,'friction_angular':0.945,
                   'restitution':0.46,'power_scale':0.95,
                   'portals':'random','bumpers':[]},   # 'random' = generated per round
    'bumper':     {'name':'Bumper Arena',  'desc':'Random bumpers deflect pens!',
                   'emoji':'🎯','bg':'bumper',
                   'friction_linear':0.972,'friction_angular':0.948,
                   'restitution':0.55,'power_scale':0.95,
                   'portals':[],'bumpers':'random'},   # 'random' = generated per round
}

BEST_OF    = 3
WIN_ROUNDS = math.ceil(BEST_OF/2)  # 2

# ── Pen types ──────────────────────────────────────────────────────────────────
PEN_TYPES = {
    'ballpoint':  {'width':120,'height':32,'weight':1.20,'defense':0.28,'color':'#3a3a3a','emoji':'🖊️','name':'Ballpoint'},
    'gel':        {'width':100,'height':26,'weight':0.80,'defense':0.12,'color':'#00bcd4','emoji':'🖋️','name':'Gel Pen'},
    'fountain':   {'width':140,'height':40,'weight':2.00,'defense':0.70,'color':'#8b4513','emoji':'✒️','name':'Fountain'},
    'marker':     {'width':130,'height':38,'weight':1.70,'defense':0.42,'color':'#ff5722','emoji':'🖍️','name':'Marker'},
    'highlighter':{'width':115,'height':34,'weight':0.90,'defense':0.18,'color':'#ffeb3b','emoji':'✏️','name':'Highlighter'},
    'stylus':     {'width': 90,'height':22,'weight':2.40,'defense':0.88,'color':'#9c27b0','emoji':'📌','name':'Stylus'},
    'quill':      {'width':155,'height':18,'weight':0.60,'defense':0.08,'color':'#f5f0e0','emoji':'🪶','name':'Quill'},
    'crayon':     {'width':105,'height':44,'weight':1.40,'defense':0.35,'color':'#e91e63','emoji':'🎨','name':'Crayon'},
    'whiteboard': {'width':145,'height':36,'weight':1.55,'defense':0.50,'color':'#43a047','emoji':'🖌️','name':'Whiteboard'},
    'needle':     {'width': 75,'height':12,'weight':3.00,'defense':0.95,'color':'#b0bec5','emoji':'📍','name':'Needle'},
}

# ── Powerup definitions ────────────────────────────────────────────────────────
POWERUP_TYPES = {
    'speed_boost':{'name':'Speed Boost','emoji':'⚡','color':'#facc15',
                   'desc':'+80% shot power for 1 shot'},
    'heavy':      {'name':'Heavy','emoji':'🏋️','color':'#6366f1',
                   'desc':'Double weight for 3 turns (harder to push)'},
    'ghost':      {'name':'Ghost','emoji':'👻','color':'#e2e8f0',
                   'desc':'Pass through next collision'},
    'shield':     {'name':'Shield','emoji':'🛡️','color':'#0ea5e9',
                   'desc':'Block next incoming hit completely'},
    'magnet':     {'name':'Repulse','emoji':'🧲','color':'#f43f5e',
                   'desc':'Blast nearby pens away on next shot'},
}
POWERUP_SPAWN_INTERVAL = 3
POWERUP_LIFETIME       = 360   # frames

PHYSICS_FPS     = 60
BROADCAST_EVERY = 2
IDLE_SPEED      = 0.06
MAX_POWER_BASE  = 6.8

rooms   = {}
players = {}

# ── Random level generators ───────────────────────────────────────────────────
def random_portals():
    """2 portal pairs at random positions, well inside the table."""
    margin = 80
    def rpos():
        return (TL+margin + random.random()*(TW-2*margin),
                TT+margin + random.random()*(TH-2*margin))
    colors = [('#a855f7','#f97316'),('#06b6d4','#f59e0b')]
    c = random.choice(colors)
    a1,a2 = rpos(), rpos()
    # Ensure portals are not too close to each other
    while math.hypot(a1[0]-a2[0],a1[1]-a2[1]) < 180:
        a2 = rpos()
    return [
        {'ax':round(a1[0]),'ay':round(a1[1]),
         'bx':round(a2[0]),'by':round(a2[1]),
         'radius':30,'color':c[0],'color2':c[1]},
    ]

def random_bumpers():
    """4-7 bumpers with random positions and sizes."""
    count  = random.randint(4,7)
    margin = 100
    bumpers= []
    attempts = 0
    while len(bumpers) < count and attempts < 200:
        attempts += 1
        x = TL+margin + random.random()*(TW-2*margin)
        y = TT+margin + random.random()*(TH-2*margin)
        r = random.randint(18,36)
        # Keep away from center spawn area and other bumpers
        if math.hypot(x-(TL+TR)/2, y-(TT+TB)/2) < 120:
            continue
        too_close = any(math.hypot(x-b['x'],y-b['y'])<b['r']+r+30 for b in bumpers)
        if not too_close:
            bumpers.append({'x':round(x),'y':round(y),'r':r})
    return bumpers

def random_powerup_pos():
    margin = 90
    return (TL+margin+random.random()*(TW-2*margin),
            TT+margin+random.random()*(TH-2*margin))

# ── Pen factory ───────────────────────────────────────────────────────────────
def make_pen(pen_type, x, y, angle=0.0):
    pt = PEN_TYPES[pen_type]
    return {**pt, 'x':float(x),'y':float(y),'vx':0.,'vy':0.,
            'angle':float(angle),'angularVelocity':0.,
            'alive':True,'type':pen_type,'portal_cooldown':0,
            'oob_frames':0,
            # powerup state
            'active_powerup':None,'powerup_turns':0,
            'ghost_charges':0,'shield_charges':0,
            'base_weight':float(pt['weight']),  # store original for heavy reset
            }

def spawn_positions(pen_objs):
    n = len(pen_objs)
    if n == 0: return []
    avg_r = sum(math.hypot(p['width'],p['height'])/2 for p in pen_objs)/n
    ring_r = avg_r * (1.0 if n<=2 else 1.1)
    cx,cy = (TL+TR)/2,(TT+TB)/2
    return [(cx+ring_r*math.cos(2*math.pi*i/n-math.pi/2),
             cy+ring_r*math.sin(2*math.pi*i/n-math.pi/2),
             2*math.pi*i/n) for i in range(n)]

def _pinfo(room):
    return {pid:{'name':p['name'],'penType':p['pen_type'],'ready':p['ready']}
            for pid,p in room['players'].items()}

def gen_code():
    while True:
        c=''.join(random.choices(string.ascii_uppercase,k=4))
        if c not in rooms: return c

# ── SAT Physics ───────────────────────────────────────────────────────────────
def corners(p):
    cx,cy=p['x'],p['y']; hw,hh=p['width']/2,p['height']/2; a=p['angle']
    c,s=math.cos(a),math.sin(a)
    return [(cx+sx*c-sy*s,cy+sx*s+sy*c) for sx,sy in [(-hw,-hh),(hw,-hh),(hw,hh),(-hw,hh)]]

def edge_normals(pts):
    axs=[]
    for i in range(len(pts)):
        ex=pts[(i+1)%len(pts)][0]-pts[i][0]; ey=pts[(i+1)%len(pts)][1]-pts[i][1]
        L=math.hypot(ex,ey)
        if L>0: axs.append((-ey/L,ex/L))
    return axs

def project(pts,ax):
    d=[p[0]*ax[0]+p[1]*ax[1] for p in pts]; return min(d),max(d)

def sat_test(pa,pb):
    ca,cb=corners(pa),corners(pb)
    best_ov,best_ax=float('inf'),None
    for ax in edge_normals(ca)+edge_normals(cb):
        mna,mxa=project(ca,ax); mnb,mxb=project(cb,ax)
        ov=min(mxa,mxb)-max(mna,mnb)
        if ov<=0: return False,0,None,None
        if ov<best_ov: best_ov,best_ax=ov,ax
    dx,dy=pb['x']-pa['x'],pb['y']-pa['y']
    if dx*best_ax[0]+dy*best_ax[1]<0: best_ax=(-best_ax[0],-best_ax[1])
    cpts=[]
    for c in ca:
        mn,mx=project(cb,best_ax); pj=c[0]*best_ax[0]+c[1]*best_ax[1]
        if mn<=pj<=mx: cpts.append(c)
    for c in cb:
        mn,mx=project(ca,best_ax); pj=c[0]*best_ax[0]+c[1]*best_ax[1]
        if mn<=pj<=mx: cpts.append(c)
    if cpts: cpx=sum(p[0] for p in cpts)/len(cpts); cpy=sum(p[1] for p in cpts)/len(cpts)
    else:    cpx,cpy=(pa['x']+pb['x'])/2,(pa['y']+pb['y'])/2
    return True,best_ov,best_ax,(cpx,cpy)

def resolve_collision(pa,pb,ov,axis,contact,e):
    # Ghost: pass through
    if pa.get('ghost_charges',0)>0: pa['ghost_charges']-=1; return 0.0
    if pb.get('ghost_charges',0)>0: pb['ghost_charges']-=1; return 0.0

    total_m=pa['weight']+pb['weight']
    pa['x']-=axis[0]*ov*(pb['weight']/total_m)
    pa['y']-=axis[1]*ov*(pb['weight']/total_m)
    pb['x']+=axis[0]*ov*(pa['weight']/total_m)
    pb['y']+=axis[1]*ov*(pa['weight']/total_m)

    Ia=pa['weight']*(pa['width']**2+pa['height']**2)/12.
    Ib=pb['weight']*(pb['width']**2+pb['height']**2)/12.
    ma,mb=pa['weight'],pb['weight']
    rax,ray=contact[0]-pa['x'],contact[1]-pa['y']
    rbx,rby=contact[0]-pb['x'],contact[1]-pb['y']
    vac=(pa['vx']-pa['angularVelocity']*ray,pa['vy']+pa['angularVelocity']*rax)
    vbc=(pb['vx']-pb['angularVelocity']*rby,pb['vy']+pb['angularVelocity']*rbx)
    rvn=(vac[0]-vbc[0])*axis[0]+(vac[1]-vbc[1])*axis[1]
    if rvn>=0: return 0.

    ran=rax*axis[1]-ray*axis[0]; rbn=rbx*axis[1]-rby*axis[0]
    inv=1/ma+1/mb+ran**2/Ia+rbn**2/Ib
    j=-(1.+e)*rvn/inv

    # Shield: absorb all incoming impulse this once
    da=0.99 if pb.get('shield_charges',0)>0 else pa['defense']
    db=0.99 if pa.get('shield_charges',0)>0 else pb['defense']
    if pb.get('shield_charges',0)>0: pb['shield_charges']-=1
    if pa.get('shield_charges',0)>0: pa['shield_charges']-=1

    sa=(1.-da); jxa=j*axis[0]*sa/ma; jya=j*axis[1]*sa/ma
    pa['vx']+=jxa; pa['vy']+=jya
    pa['angularVelocity']+=(rax*jya-ray*jxa)*sa/Ia*ma

    sb=(1.-db); jxb=-j*axis[0]*sb/mb; jyb=-j*axis[1]*sb/mb
    pb['vx']+=jxb; pb['vy']+=jyb
    pb['angularVelocity']+=(rbx*jyb-rby*jxb)*sb/Ib*mb
    return abs(j)

def pen_bumper_collision(pen, bx, by, br, restitution):
    """Reflect pen off circular bumper."""
    dx=pen['x']-bx; dy=pen['y']-by
    dist=math.hypot(dx,dy)
    pen_r=math.hypot(pen['width'],pen['height'])/2
    if dist<pen_r+br and dist>0.01:
        nx,ny=dx/dist,dy/dist
        # Push pen out
        overlap=(pen_r+br)-dist
        pen['x']+=nx*overlap; pen['y']+=ny*overlap
        # Reflect velocity
        dot=pen['vx']*nx+pen['vy']*ny
        if dot<0:
            pen['vx']-=2*dot*nx*restitution
            pen['vy']-=2*dot*ny*restitution
            pen['angularVelocity']*=0.75
            return abs(dot)*pen['weight']
    return 0.

def apply_portals(pen,portals):
    if pen.get('portal_cooldown',0)>0: pen['portal_cooldown']-=1; return False
    for p in portals:
        if math.hypot(pen['x']-p['ax'],pen['y']-p['ay'])<p['radius']:
            pen['x']=float(p['bx']); pen['y']=float(p['by'])
            pen['portal_cooldown']=50; return True
        if math.hypot(pen['x']-p['bx'],pen['y']-p['by'])<p['radius']:
            pen['x']=float(p['ax']); pen['y']=float(p['ay'])
            pen['portal_cooldown']=50; return True
    return False

def check_elimination(pen):
    hw=pen['width']/2.; hh=pen['height']/2.
    a=pen['angle']; ca=abs(math.cos(a)); sa=abs(math.sin(a))
    ext_x=hw*ca+hh*sa; ext_y=hw*sa+hh*ca
    if pen['x']-ext_x*0.5>TR: return True
    if pen['x']+ext_x*0.5<TL: return True
    if pen['y']-ext_y*0.5>TB: return True
    if pen['y']+ext_y*0.5<TT: return True
    return False

def check_powerup_pickup(pen,game):
    for i,pu in enumerate(game.get('powerups',[])):
        if math.hypot(pen['x']-pu['x'],pen['y']-pu['y'])<32:
            return i
    return -1

def apply_powerup(pen,pu_type):
    """Apply powerup immediately to pen state."""
    pen['active_powerup']=pu_type
    if pu_type=='heavy':
        pen['weight']=pen['base_weight']*2.0
        pen['powerup_turns']=3
    elif pu_type=='ghost':
        pen['ghost_charges']=1
    elif pu_type=='shield':
        pen['shield_charges']=1
    # speed_boost and magnet are consumed at shoot time

def decay_powerups(game):
    """Called after each turn to tick down turn-based powerups."""
    for pen in game['pens'].values():
        if not pen['alive']: continue
        if pen.get('active_powerup')=='heavy' and pen.get('powerup_turns',0)>0:
            pen['powerup_turns']-=1
            if pen['powerup_turns']<=0:
                pen['weight']=pen['base_weight']
                pen['active_powerup']=None

def magnet_repulse(shooter,pens,game):
    """Blast all other alive pens away from shooter."""
    events=[]
    for pid,pen in pens.items():
        if not pen['alive'] or pen is shooter: continue
        dx=pen['x']-shooter['x']; dy=pen['y']-shooter['y']
        dist=max(math.hypot(dx,dy),1)
        force=min(400/dist,12.)
        pen['vx']+=dx/dist*force; pen['vy']+=dy/dist*force
        events.append({'x':round(pen['x']),'y':round(pen['y']),'impulse':force})
    return events

def step(game):
    m=MAPS[game['map']]; fl=m['friction_linear']; fa=m['friction_angular']
    res=m['restitution']; portals=game.get('portals',[]); bumpers=game.get('bumpers',[])
    alive=[pid for pid,p in game['pens'].items() if p['alive']]
    collision_events=[]; powerup_events=[]

    for pid in alive:
        p=game['pens'][pid]
        p['x']+=p['vx']; p['y']+=p['vy']
        p['angle']+=p['angularVelocity']
        p['vx']*=fl; p['vy']*=fl; p['angularVelocity']*=fa
        if abs(p['vx'])<0.002: p['vx']=0.
        if abs(p['vy'])<0.002: p['vy']=0.
        if abs(p['angularVelocity'])<0.001: p['angularVelocity']=0.
        if portals: apply_portals(p,portals)

    # Pen–pen collisions (3 iterations)
    for _ in range(3):
        for i in range(len(alive)):
            for j in range(i+1,len(alive)):
                pa,pb=game['pens'][alive[i]],game['pens'][alive[j]]
                col,ov,ax,ct=sat_test(pa,pb)
                if col:
                    imp=resolve_collision(pa,pb,ov,ax,ct,res)
                    if imp>0.5 and ct:
                        collision_events.append({'x':round(ct[0]),'y':round(ct[1]),
                                                  'impulse':round(min(imp,20),2)})

    # Bumper collisions
    for pid in alive:
        for b in bumpers:
            imp=pen_bumper_collision(game['pens'][pid],b['x'],b['y'],b['r'],res)
            if imp>0.3:
                collision_events.append({'x':b['x'],'y':b['y'],'impulse':round(min(imp,10),2),'bumper':True})

    # Powerup pickups
    for pid in alive:
        p=game['pens'][pid]
        idx=check_powerup_pickup(p,game)
        if idx>=0:
            pu=game['powerups'].pop(idx)
            apply_powerup(p,pu['type'])
            powerup_events.append({'pid':pid,'puType':pu['type'],'x':pu['x'],'y':pu['y']})

    # Powerup lifetime decay
    for pu in game.get('powerups',[]):
        pu['life']=pu.get('life',POWERUP_LIFETIME)-1
    game['powerups']=[pu for pu in game.get('powerups',[]) if pu['life']>0]

    # Elimination
    for pid in alive:
        pen=game['pens'][pid]
        if not pen['alive']: continue
        if check_elimination(pen):
            pen['alive']=False; pen['vx']=pen['vy']=pen['angularVelocity']=0.
            if pid not in game['eliminated']: game['eliminated'].append(pid)

    game['collision_events']=collision_events
    game['powerup_events']=powerup_events

def all_idle(pens):
    return all(math.hypot(p['vx'],p['vy'])<=IDLE_SPEED and
               abs(p['angularVelocity'])<=IDLE_SPEED
               for p in pens.values() if p['alive'])

def serialize(game,room):
    skip={'oob_frames','base_weight'}
    pens_out={}
    for pid,pen in game['pens'].items():
        pens_out[pid]={k:(round(v,3) if isinstance(v,float) else v)
                       for k,v in pen.items() if k not in skip}
    return {
        'pens':           pens_out,
        'turnOrder':      game['turn_order'],
        'turnIndex':      game['turn_index'],
        'currentTurn':    game['turn_order'][game['turn_index']] if game['turn_order'] else None,
        'eliminated':     game['eliminated'],
        'phase':          game['phase'],
        'map':            game['map'],
        'portals':        game.get('portals',[]),
        'bumpers':        game.get('bumpers',[]),
        'round':          room['round'],
        'roundWins':      room['round_wins'],
        'bestOf':         BEST_OF,
        'winRounds':      WIN_ROUNDS,
        'collisionEvents':game.get('collision_events',[]),
        'powerupEvents':  game.get('powerup_events',[]),
        'powerups':       [{k:v for k,v in pu.items() if k!='life'} | {'lifetime':pu.get('life',0)}
                           for pu in game.get('powerups',[])],
        'powerupTypes':   {k:{'name':v['name'],'emoji':v['emoji'],'color':v['color']}
                           for k,v in POWERUP_TYPES.items()},
        'players':        {pid:{'name':p['name'],'penType':p['pen_type']}
                           for pid,p in room['players'].items()},
    }

def start_round(room_code):
    room=rooms.get(room_code)
    if not room: return
    pids=list(room['players'].keys())
    pen_objs=[make_pen(room['players'][pid]['pen_type'],0,0) for pid in pids]
    positions=spawn_positions(pen_objs)
    chosen_map=room.get('chosen_map','classic')

    pens={pid:make_pen(room['players'][pid]['pen_type'],*positions[i])
          for i,pid in enumerate(pids)}
    order=room.get('last_turn_order',None)
    if not order: order=pids[:]; random.shuffle(order)

    # Generate random portals/bumpers for this round
    map_portals=[]
    map_bumpers=[]
    if MAPS[chosen_map]['portals']=='random':
        map_portals=random_portals()
    elif MAPS[chosen_map]['portals']:
        map_portals=MAPS[chosen_map]['portals']

    if MAPS[chosen_map]['bumpers']=='random':
        map_bumpers=random_bumpers()

    room['game']={
        'pens':pens,'turn_order':order,'turn_index':0,
        'eliminated':[],'phase':'aiming','map':chosen_map,
        'portals':map_portals,'bumpers':map_bumpers,
        'collision_events':[],'powerup_events':[],'powerups':[],
        'turns_since_powerup':0,
    }
    state=serialize(room['game'],room); state['simulating']=False
    socketio.emit('round_started',state,room=room_code)

def end_round(room_code,winner_pid):
    room=rooms.get(room_code)
    if not room: return
    game=room['game']
    room['last_turn_order']=game['turn_order'][:]
    if winner_pid: room['round_wins'][winner_pid]=room['round_wins'].get(winner_pid,0)+1
    room['round']+=1
    match_winner=None
    for pid,wins in room['round_wins'].items():
        if wins>=WIN_ROUNDS: match_winner=pid; break
    wname=(room['players'][winner_pid]['name']
           if winner_pid and winner_pid in room['players'] else 'No survivor')
    if match_winner:
        room['started']=False
        socketio.emit('match_over',{
            'roundWinner':winner_pid,'roundWinnerName':wname,
            'matchWinner':match_winner,'matchWinnerName':room['players'][match_winner]['name'],
            'roundWins':room['round_wins'],},room=room_code)
    else:
        socketio.emit('round_over',{
            'roundWinner':winner_pid,'roundWinnerName':wname,
            'roundWins':room['round_wins'],'nextRound':room['round'],},room=room_code)
        threading.Timer(3.5,start_round,args=(room_code,)).start()

def run_physics(room_code):
    room=rooms.get(room_code)
    if not room or 'game' not in room: return
    game=room['game']; frame=0
    while frame<PHYSICS_FPS*30:
        step(game); frame+=1
        if frame%BROADCAST_EVERY==0:
            state=serialize(game,room); state['simulating']=True
            socketio.emit('game_state_update',state,room=room_code)
            game['collision_events']=[]; game['powerup_events']=[]
        alive_now=[pid for pid,p in game['pens'].items() if p['alive']]
        if len(alive_now)<=1: break
        if all_idle(game['pens']): break
    alive=[pid for pid,p in game['pens'].items() if p['alive']]
    if len(alive)<=1:
        game['phase']='round_over'
        state=serialize(game,room); state['simulating']=False
        socketio.emit('game_state_update',state,room=room_code)
        game['collision_events']=[]; game['powerup_events']=[]
        end_round(room_code,alive[0] if alive else None)
        return
    game['phase']='aiming'
    advance_turn(game)
    # Spawn powerup every N turns
    game['turns_since_powerup']=game.get('turns_since_powerup',0)+1
    if game['turns_since_powerup']>=POWERUP_SPAWN_INTERVAL:
        pu_type=random.choice(list(POWERUP_TYPES.keys()))
        x,y=random_powerup_pos()
        game['powerups'].append({'type':pu_type,'x':x,'y':y,
                                  'emoji':POWERUP_TYPES[pu_type]['emoji'],
                                  'color':POWERUP_TYPES[pu_type]['color'],
                                  'life':POWERUP_LIFETIME})
        game['turns_since_powerup']=0
    decay_powerups(game)
    state=serialize(game,room); state['simulating']=False
    socketio.emit('game_state_update',state,room=room_code)

def advance_turn(game):
    order,pens,n=game['turn_order'],game['pens'],len(game['turn_order'])
    for _ in range(n):
        game['turn_index']=(game['turn_index']+1)%n
        if pens[order[game['turn_index']]]['alive']: return
    game['phase']='round_over'

# ── Socket events ──────────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect(): print(f'[+] {sio_request.sid}')

@socketio.on('disconnect')
def on_disconnect():
    sid=sio_request.sid; info=players.pop(sid,None)
    if not info: return
    room=rooms.get(info['room'])
    if not room: return
    pid=info['player_id']; room['players'].pop(pid,None)
    if not room['players']: rooms.pop(info['room'],None); return
    emit('player_left',{'playerId':pid},room=info['room'])
    if 'game' in room and pid in room['game']['pens']:
        room['game']['pens'][pid]['alive']=False

@socketio.on('create_room')
def on_create_room(data):
    sid=sio_request.sid; name=data.get('name','Player')[:20]
    code=gen_code(); pid='p1'
    rooms[code]={'code':code,'host':pid,
                  'players':{pid:{'name':name,'sid':sid,'pen_type':'ballpoint','ready':False}},
                  'started':False,'round':1,'round_wins':{},
                  'chosen_map':'classic','last_turn_order':None}
    players[sid]={'room':code,'player_id':pid}
    sio_join_room(code)
    emit('room_created',{'code':code,'playerId':pid,'players':_pinfo(rooms[code]),
                          'host':pid,'chosenMap':'classic'})

@socketio.on('join_room')
def on_join_room(data):
    sid=sio_request.sid; code=data.get('code','').upper(); name=data.get('name','Player')[:20]
    room=rooms.get(code)
    if not room:                emit('error',{'msg':'Room not found'}); return
    if room['started']:         emit('error',{'msg':'Game already started'}); return
    if len(room['players'])>=6: emit('error',{'msg':'Room is full'}); return
    pid=f'p{len(room["players"])+1}'
    room['players'][pid]={'name':name,'sid':sid,'pen_type':'ballpoint','ready':False}
    players[sid]={'room':code,'player_id':pid}
    sio_join_room(code)
    emit('room_joined',{'code':code,'playerId':pid,'players':_pinfo(room),
                         'host':room['host'],'chosenMap':room.get('chosen_map','classic')})
    emit('player_joined',{'playerId':pid,'name':name,'players':_pinfo(room)},
         room=code,include_self=False)

@socketio.on('select_pen')
def on_select_pen(data):
    sid=sio_request.sid; info=players.get(sid)
    if not info: return
    room=rooms.get(info['room'])
    if not room: return
    pt=data.get('penType','ballpoint')
    if pt not in PEN_TYPES: return
    room['players'][info['player_id']]['pen_type']=pt
    emit('pen_selected',{'playerId':info['player_id'],'penType':pt},room=info['room'])

@socketio.on('select_map')
def on_select_map(data):
    sid=sio_request.sid; info=players.get(sid)
    if not info: return
    room=rooms.get(info['room'])
    if not room or info['player_id']!=room['host']: return
    chosen=data.get('mapKey','classic')
    if chosen not in MAPS: return
    room['chosen_map']=chosen
    socketio.emit('map_selected',{'mapKey':chosen,'mapName':MAPS[chosen]['name']},
                  room=info['room'])

@socketio.on('start_game')
def on_start_game():
    sid=sio_request.sid; info=players.get(sid)
    if not info: return
    room=rooms.get(info['room'])
    if not room or info['player_id']!=room['host']: return
    if len(room['players'])<2: emit('error',{'msg':'Need at least 2 players'}); return
    room['started']=True; room['round']=1
    room['round_wins']={pid:0 for pid in room['players']}
    room['last_turn_order']=None
    start_round(info['room'])

@socketio.on('shoot')
def on_shoot(data):
    sid=sio_request.sid; info=players.get(sid)
    if not info: return
    room=rooms.get(info['room'])
    if not room or 'game' not in room: return
    game=room['game']; pid=info['player_id']
    if pid!=game['turn_order'][game['turn_index']]:
        emit('error',{'msg':'Not your turn'}); return
    if game['phase']!='aiming':
        emit('error',{'msg':'Wait for physics'}); return

    dx=float(data.get('dx',0)); dy=float(data.get('dy',0))
    power=min(float(data.get('power',0)),MAX_POWER_BASE)
    pscale=MAPS[game['map']]['power_scale']

    # Apply speed_boost powerup
    pen=game['pens'].get(pid)
    if not pen or not pen['alive']: return
    if pen.get('active_powerup')=='speed_boost':
        power=min(power*1.8, MAX_POWER_BASE*1.8)
        pen['active_powerup']=None

    power*=pscale
    mag=math.hypot(dx,dy)
    if mag<0.001: return
    dx/=mag; dy/=mag

    # Magnet repulse fires at shoot moment
    magnet_evs=[]
    if pen.get('active_powerup')=='magnet':
        magnet_evs=magnet_repulse(pen,game['pens'],game)
        pen['active_powerup']=None

    pen['vx']=dx*power; pen['vy']=dy*power
    pen_ax=math.cos(pen['angle']); pen_ay=math.sin(pen['angle'])
    pen['angularVelocity']=(dx*pen_ay-dy*pen_ax)*0.18*power*0.06

    game['phase']='simulating'
    game['collision_events']=magnet_evs
    game['powerup_events']=[]
    threading.Thread(target=run_physics,args=(info['room'],),daemon=True).start()

@socketio.on('skip_physics')
def on_skip():
    sid=sio_request.sid; info=players.get(sid)
    if not info: return
    room=rooms.get(info['room'])
    if not room or 'game' not in room: return
    for pen in room['game']['pens'].values():
        pen['vx']=pen['vy']=pen['angularVelocity']=0.

@socketio.on('rematch')
def on_rematch():
    sid=sio_request.sid; info=players.get(sid)
    if not info: return
    room=rooms.get(info['room'])
    if not room or info['player_id']!=room['host']: return
    room['started']=False; room.pop('game',None)
    room['round']=1; room['round_wins']={pid:0 for pid in room['players']}
    room['last_turn_order']=None
    emit('lobby_reset',{'players':_pinfo(room),'host':room['host']},room=info['room'])

@app.route('/')
def index(): return send_from_directory(BASE_DIR,'index.html')

@app.route('/api/sprites')
def get_sprites():
    out,adir={},os.path.join(BASE_DIR,'static','assets')
    for k in PEN_TYPES:
        p=os.path.join(adir,f'{k}.png')
        if os.path.exists(p):
            with open(p,'rb') as f:
                out[k]='data:image/png;base64,'+base64.b64encode(f.read()).decode()
    return jsonify(out)

@app.route('/api/maps')
def get_maps():
    return jsonify({k:{'name':m['name'],'desc':m['desc'],'emoji':m['emoji'],'bg':m['bg']}
                    for k,m in MAPS.items()})

if __name__=='__main__':
    try:
        from pyngrok import ngrok as _ng; t=_ng.connect(5000)
        print(f'\n🌐  Share: {t.public_url}\n')
    except Exception as e: print(f'[ngrok] {e}')
    print('🖊️  PenFight Arena v8 → http://localhost:5000')
    socketio.run(app,host='0.0.0.0',port=5000,debug=False,allow_unsafe_werkzeug=True)
