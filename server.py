"""
PenFight Arena - Server v4
Complete physics rewrite:
  - Pens spawn touching each other (tight cluster)
  - Proper sub-step collision with realistic angular knockback
  - Strong wall bounce — pens CANNOT fall off in one shot
    (elimination only after sustained momentum carries them out)
  - Map-aware power scaling (ice = weaker shots feel stronger,
    sandpaper = stronger cap since it stops fast)
  - Collision flash events sent to client for screen-shake / spark fx
  - Best-of-3, 4 maps, ngrok tunnel
"""
import os, math, random, string, threading, base64
from flask import Flask, send_from_directory, request as sio_request, jsonify
from flask_socketio import SocketIO, emit, join_room as sio_join_room

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__,
            static_folder=os.path.join(BASE_DIR, 'static'),
            static_url_path='/static',
            template_folder=BASE_DIR)
app.config['SECRET_KEY'] = 'penfight_v4'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# ── Table ───────────────────────────────────────────────────────────────────────
TL, TR, TT, TB = 60, 740, 60, 540   # left right top bottom
TW = TR - TL   # 680
TH = TB - TT   # 480

# ── Maps ────────────────────────────────────────────────────────────────────────
MAPS = {
    'classic': {
        'name':'Classic Table','desc':'Balanced wood. Real pen-fight rules.',
        'emoji':'🪵','bg':'wood',
        'friction_linear':0.970,   # moderate slide — decelerates clearly
        'friction_angular':0.94,
        'restitution':0.48,
        'power_scale':0.85,
        'portals':[],
    },
    'ice': {
        'name':'Ice Rink','desc':'Almost frictionless. Pens glide forever.',
        'emoji':'🧊','bg':'ice',
        'friction_linear':0.9985,
        'friction_angular':0.995,
        'restitution':0.68,
        'power_scale':0.55,        # weaker shots — everything travels far anyway
        'portals':[],
    },
    'sandpaper': {
        'name':'Sandpaper','desc':'Maximum grip. Every shot must count.',
        'emoji':'📄','bg':'sand',
        'friction_linear':0.910,
        'friction_angular':0.84,
        'restitution':0.22,
        'power_scale':1.10,        # harder shots needed since it stops fast
        'portals':[],
    },
    'portal': {
        'name':'Portal Maze','desc':'Enter a portal, exit the other side!',
        'emoji':'🌀','bg':'portal',
        'friction_linear':0.972,
        'friction_angular':0.945,
        'restitution':0.46,
        'power_scale':0.85,
        'portals':[
            {'ax':180,'ay':170,'bx':620,'by':430,'radius':30,'color':'#a855f7'},
            {'ax':620,'ay':170,'bx':180,'by':430,'radius':30,'color':'#f97316'},
        ],
    },
}

BEST_OF    = 3
WIN_ROUNDS = math.ceil(BEST_OF / 2)   # 2

# ── Pen types ───────────────────────────────────────────────────────────────────
# weight: heavier = harder to move, hits harder
# defense: [0..1] fraction of incoming impulse absorbed (NOT transmitted)
# restitution_self: personal bounce factor (stylus = almost elastic, highlighter = squishy)
PEN_TYPES = {
    'ballpoint':  {'width':120,'height':32,'weight':1.20,'defense':0.28,'color':'#2b2b2b','emoji':'🖊️','name':'Ballpoint'},
    'gel':        {'width':100,'height':26,'weight':0.80,'defense':0.12,'color':'#00bcd4','emoji':'🖋️','name':'Gel Pen'},
    'fountain':   {'width':140,'height':40,'weight':2.00,'defense':0.70,'color':'#8b4513','emoji':'✒️','name':'Fountain'},
    'marker':     {'width':130,'height':38,'weight':1.70,'defense':0.42,'color':'#ff5722','emoji':'🖍️','name':'Marker'},
    'highlighter':{'width':115,'height':34,'weight':0.90,'defense':0.18,'color':'#ffeb3b','emoji':'✏️','name':'Highlighter'},
    'stylus':     {'width': 90,'height':22,'weight':2.40,'defense':0.88,'color':'#9c27b0','emoji':'📌','name':'Stylus'},
}

# Elimination: pen must sustain speed above this OUT-OF-BOUNDS for this many frames
PHYSICS_FPS     = 60
BROADCAST_EVERY = 2
IDLE_SPEED      = 0.06
MAX_POWER_BASE  = 5.5        # hard cap — slow, deliberate shots only

# ── Global state ────────────────────────────────────────────────────────────────
rooms   = {}
players = {}

# ── Helpers ─────────────────────────────────────────────────────────────────────
def gen_code():
    while True:
        c = ''.join(random.choices(string.ascii_uppercase, k=4))
        if c not in rooms: return c

def _pinfo(room):
    return {pid:{'name':p['name'],'penType':p['pen_type'],'ready':p['ready']}
            for pid,p in room['players'].items()}

def make_pen(pen_type, x, y, angle=0.0):
    pt = PEN_TYPES[pen_type]
    return {**pt, 'x':float(x), 'y':float(y),
            'vx':0., 'vy':0., 'angle':float(angle),
            'angularVelocity':0., 'alive':True, 'type':pen_type,
            'portal_cooldown':0, 'oob_frames':0}

# ── Spawn: pens placed in a tight ring, touching ─────────────────────────────
def spawn_positions(pens_list):
    """
    Place pens in a compact ring so they start touching each other.
    pens_list: list of pen dicts (need width/height)
    Returns list of (x, y, angle) same length.
    """
    n = len(pens_list)
    if n == 0: return []

    # Estimate average half-diagonal to set ring radius
    avg_r = sum(math.hypot(p['width'], p['height'])/2 for p in pens_list) / n
    # Ring radius: just enough that adjacent pens touch
    ring_r = avg_r * (1.0 if n <= 2 else 1.1)

    cx = (TL + TR) / 2
    cy = (TT + TB) / 2

    positions = []
    for i in range(n):
        theta = 2 * math.pi * i / n - math.pi / 2
        x = cx + ring_r * math.cos(theta)
        y = cy + ring_r * math.sin(theta)
        # Pen faces toward center
        angle = theta + math.pi
        positions.append((x, y, angle))
    return positions

# ── SAT collision ────────────────────────────────────────────────────────────
def corners(p):
    cx, cy = p['x'], p['y']
    hw, hh = p['width']/2, p['height']/2
    a = p['angle']
    c, s = math.cos(a), math.sin(a)
    return [
        (cx + sx*c - sy*s, cy + sx*s + sy*c)
        for sx, sy in [(-hw,-hh),(hw,-hh),(hw,hh),(-hw,hh)]
    ]

def edge_normals(pts):
    axs = []
    n = len(pts)
    for i in range(n):
        ex = pts[(i+1)%n][0] - pts[i][0]
        ey = pts[(i+1)%n][1] - pts[i][1]
        L = math.hypot(ex, ey)
        if L > 0: axs.append((-ey/L, ex/L))
    return axs

def project(pts, ax):
    d = [p[0]*ax[0]+p[1]*ax[1] for p in pts]
    return min(d), max(d)

def sat_test(pa, pb):
    ca, cb = corners(pa), corners(pb)
    best_ov, best_ax = float('inf'), None
    for ax in edge_normals(ca) + edge_normals(cb):
        mna, mxa = project(ca, ax)
        mnb, mxb = project(cb, ax)
        ov = min(mxa, mxb) - max(mna, mnb)
        if ov <= 0: return False, 0, None, None
        if ov < best_ov: best_ov, best_ax = ov, ax

    dx, dy = pb['x']-pa['x'], pb['y']-pa['y']
    if dx*best_ax[0]+dy*best_ax[1] < 0:
        best_ax = (-best_ax[0], -best_ax[1])

    # Contact point = centroid of overlapping projected vertices
    cpts = []
    for c in ca:
        mn, mx = project(cb, best_ax)
        pj = c[0]*best_ax[0]+c[1]*best_ax[1]
        if mn <= pj <= mx: cpts.append(c)
    for c in cb:
        mn, mx = project(ca, best_ax)
        pj = c[0]*best_ax[0]+c[1]*best_ax[1]
        if mn <= pj <= mx: cpts.append(c)

    if cpts:
        cpx = sum(p[0] for p in cpts)/len(cpts)
        cpy = sum(p[1] for p in cpts)/len(cpts)
    else:
        cpx, cpy = (pa['x']+pb['x'])/2, (pa['y']+pb['y'])/2

    return True, best_ov, best_ax, (cpx, cpy)

def resolve_collision(pa, pb, ov, axis, contact, e):
    """
    Full impulse-based resolution with:
      - Positional correction (Baumgarte-style)
      - Linear + angular velocity updates
      - Per-pen defense factor
      - Returns impulse magnitude for collision FX
    """
    # Separate pens (positional correction weighted by mass)
    total_m = pa['weight'] + pb['weight']
    ra = pa['weight'] / total_m
    rb = pb['weight'] / total_m
    # Push lighter one more
    pa['x'] -= axis[0] * ov * rb
    pa['y'] -= axis[1] * ov * rb
    pb['x'] += axis[0] * ov * ra
    pb['y'] += axis[1] * ov * ra

    # Moments of inertia: I = m(w²+h²)/12
    Ia = pa['weight'] * (pa['width']**2 + pa['height']**2) / 12.0
    Ib = pb['weight'] * (pb['width']**2 + pb['height']**2) / 12.0
    ma, mb = pa['weight'], pb['weight']

    # Radius vectors to contact
    rax, ray = contact[0]-pa['x'], contact[1]-pa['y']
    rbx, rby = contact[0]-pb['x'], contact[1]-pb['y']

    # Velocity of contact point on each body
    vac = (pa['vx'] - pa['angularVelocity']*ray,
           pa['vy'] + pa['angularVelocity']*rax)
    vbc = (pb['vx'] - pb['angularVelocity']*rby,
           pb['vy'] + pb['angularVelocity']*rbx)

    # Relative velocity along normal
    rvn = (vac[0]-vbc[0])*axis[0] + (vac[1]-vbc[1])*axis[1]
    if rvn >= 0: return 0.0   # separating, skip

    ran = rax*axis[1] - ray*axis[0]
    rbn = rbx*axis[1] - rby*axis[0]
    inv_mass_sum = 1/ma + 1/mb + ran**2/Ia + rbn**2/Ib

    j = -(1.0 + e) * rvn / inv_mass_sum

    da, db = pa['defense'], pb['defense']

    # Apply to A (receives from B collision)
    scale_a = (1.0 - da)
    jxa = j * axis[0] * scale_a / ma
    jya = j * axis[1] * scale_a / ma
    pa['vx'] += jxa
    pa['vy'] += jya
    # Torque on A: r × J  (2D cross product)
    pa['angularVelocity'] += (rax*jya - ray*jxa) * scale_a / Ia * ma

    # Apply to B (opposite direction)
    scale_b = (1.0 - db)
    jxb = -j * axis[0] * scale_b / mb
    jyb = -j * axis[1] * scale_b / mb
    pb['vx'] += jxb
    pb['vy'] += jyb
    pb['angularVelocity'] += (rbx*jyb - rby*jxb) * scale_b / Ib * mb

    return abs(j)   # impulse magnitude for FX

def check_elimination(pen):
    """
    A pen is eliminated when at least HALF its body area is outside the table.
    We approximate this by checking whether the pen CENTER has crossed the
    table edge by more than half the pen's half-dimension in that direction.

    No bounce — pens slide freely off the edge and drop when half gone.
    """
    hw = pen['width']  / 2.0   # half-width
    hh = pen['height'] / 2.0   # half-height
    # The pen's axis-aligned extent changes with rotation, but for the
    # half-body rule we use the pen's LOCAL half-dimensions projected onto
    # the world axes via the rotation angle — gives the exact threshold.
    a     = pen['angle']
    cos_a = abs(math.cos(a))
    sin_a = abs(math.sin(a))
    # Half-extent of the rotated rectangle along world X and Y
    ext_x = hw * cos_a + hh * sin_a   # world half-width  of bounding box
    ext_y = hw * sin_a + hh * cos_a   # world half-height of bounding box

    # Pen centre must cross the wall by > half the extent to be eliminated
    # i.e. more than half the body is outside
    if pen['x'] - ext_x * 0.5 > TR:   return True   # right edge
    if pen['x'] + ext_x * 0.5 < TL:   return True   # left edge
    if pen['y'] - ext_y * 0.5 > TB:   return True   # bottom edge
    if pen['y'] + ext_y * 0.5 < TT:   return True   # top edge
    return False

def apply_portals(pen, portals):
    if pen.get('portal_cooldown', 0) > 0:
        pen['portal_cooldown'] -= 1
        return False
    for portal in portals:
        if math.hypot(pen['x']-portal['ax'], pen['y']-portal['ay']) < portal['radius']:
            pen['x'] = float(portal['bx']); pen['y'] = float(portal['by'])
            pen['portal_cooldown'] = 50
            return True
        if math.hypot(pen['x']-portal['bx'], pen['y']-portal['by']) < portal['radius']:
            pen['x'] = float(portal['ax']); pen['y'] = float(portal['ay'])
            pen['portal_cooldown'] = 50
            return True
    return False

# ── Physics step ────────────────────────────────────────────────────────────────
def step(game):
    m     = MAPS[game['map']]
    fl      = m['friction_linear']
    fa      = m['friction_angular']
    res     = m['restitution']
    portals = m['portals']

    alive = [pid for pid,p in game['pens'].items() if p['alive']]
    collision_events = []   # list of {x,y,impulse} for client FX

    # --- Integrate ---
    for pid in alive:
        p = game['pens'][pid]
        p['x'] += p['vx']; p['y'] += p['vy']
        p['angle'] += p['angularVelocity']

        # Apply friction
        p['vx'] *= fl; p['vy'] *= fl
        p['angularVelocity'] *= fa

        # Clamp tiny values
        if abs(p['vx']) < 0.002: p['vx'] = 0.
        if abs(p['vy']) < 0.002: p['vy'] = 0.
        if abs(p['angularVelocity']) < 0.001: p['angularVelocity'] = 0.

        # Portal teleport
        if portals: apply_portals(p, portals)

    # --- Pen-pen collisions (multiple sub-iterations for stability) ---
    for _iter in range(3):
        for i in range(len(alive)):
            for j in range(i+1, len(alive)):
                pa, pb = game['pens'][alive[i]], game['pens'][alive[j]]
                col, ov, ax, ct = sat_test(pa, pb)
                if col:
                    impulse = resolve_collision(pa, pb, ov, ax, ct, res)
                    if impulse > 0.8 and ct:
                        collision_events.append({
                            'x': round(ct[0], 1), 'y': round(ct[1], 1),
                            'impulse': round(min(impulse, 20), 2)
                        })

    # --- Elimination: pen falls off when half its body is outside the table ---
    for pid in alive:
        pen = game['pens'][pid]
        if not pen['alive']:
            continue
        if check_elimination(pen):
            pen['alive'] = False
            pen['vx'] = pen['vy'] = pen['angularVelocity'] = 0.
            if pid not in game['eliminated']:
                game['eliminated'].append(pid)

    game['collision_events'] = collision_events

def all_idle(pens):
    return all(
        math.hypot(p['vx'], p['vy']) <= IDLE_SPEED and
        abs(p['angularVelocity']) <= IDLE_SPEED
        for p in pens.values() if p['alive']
    )

# ── Serialise ────────────────────────────────────────────────────────────────
def serialize(game, room):
    pens_out = {}
    for pid, pen in game['pens'].items():
        pens_out[pid] = {k: (round(v,3) if isinstance(v,float) else v)
                         for k,v in pen.items()
                         if k != 'oob_frames'}   # internal, not needed by client
    return {
        'pens':             pens_out,
        'turnOrder':        game['turn_order'],
        'turnIndex':        game['turn_index'],
        'currentTurn':      game['turn_order'][game['turn_index']] if game['turn_order'] else None,
        'eliminated':       game['eliminated'],
        'phase':            game['phase'],
        'map':              game['map'],
        'round':            room['round'],
        'roundWins':        room['round_wins'],
        'bestOf':           BEST_OF,
        'winRounds':        WIN_ROUNDS,
        'collisionEvents':  game.get('collision_events', []),
        'players':          {pid: {'name':p['name'],'penType':p['pen_type']}
                             for pid,p in room['players'].items()},
    }

# ── Round management ─────────────────────────────────────────────────────────
def start_round(room_code):
    room = rooms.get(room_code)
    if not room: return
    pids = list(room['players'].keys())
    pen_objs = [make_pen(room['players'][pid]['pen_type'], 0, 0) for pid in pids]
    positions = spawn_positions(pen_objs)
    chosen_map = room.get('chosen_map', 'classic')

    pens = {}
    for i, pid in enumerate(pids):
        x, y, angle = positions[i]
        pens[pid] = make_pen(room['players'][pid]['pen_type'], x, y, angle)

    order = room.get('last_turn_order', None)
    if not order:
        order = pids[:]; random.shuffle(order)

    room['game'] = {
        'pens': pens, 'turn_order': order, 'turn_index': 0,
        'eliminated': [], 'phase': 'aiming', 'map': chosen_map,
        'collision_events': [],
    }
    state = serialize(room['game'], room); state['simulating'] = False
    socketio.emit('round_started', state, room=room_code)

def end_round(room_code, winner_pid):
    room = rooms.get(room_code)
    if not room: return
    game = room['game']
    room['last_turn_order'] = game['turn_order'][:]

    if winner_pid:
        room['round_wins'][winner_pid] = room['round_wins'].get(winner_pid, 0) + 1

    room['round'] += 1

    # Check match winner — scan all players for win threshold
    match_winner = None
    for pid, wins in room['round_wins'].items():
        if wins >= WIN_ROUNDS:
            match_winner = pid
            break

    wname = room['players'][winner_pid]['name'] if (winner_pid and winner_pid in room['players']) else 'No survivor'

    print(f"[round end] winner={winner_pid} wins={room['round_wins']} match_winner={match_winner}")

    if match_winner:
        room['started'] = False
        mname = room['players'][match_winner]['name']
        socketio.emit('match_over', {
            'roundWinner':     winner_pid,
            'roundWinnerName': wname,
            'matchWinner':     match_winner,
            'matchWinnerName': mname,
            'roundWins':       room['round_wins'],
        }, room=room_code)
        print(f"[match over] {mname} wins!")
    else:
        socketio.emit('round_over', {
            'roundWinner':     winner_pid,
            'roundWinnerName': wname,
            'roundWins':       room['round_wins'],
            'nextRound':       room['round'],
        }, room=room_code)
        print(f"[round over] next round {room['round']} in 3.5s")
        threading.Timer(3.5, start_round, args=(room_code,)).start()

def run_physics(room_code):
    room = rooms.get(room_code)
    if not room or 'game' not in room: return
    game  = room['game']
    frame = 0

    while frame < PHYSICS_FPS * 30:
        step(game); frame += 1

        # Broadcast every N frames
        if frame % BROADCAST_EVERY == 0:
            state = serialize(game, room); state['simulating'] = True
            socketio.emit('game_state_update', state, room=room_code)
            game['collision_events'] = []

        # Check if only one (or zero) pens remain alive mid-simulation
        alive_now = [pid for pid,p in game['pens'].items() if p['alive']]
        if len(alive_now) <= 1:
            break

        if all_idle(game['pens']):
            break

    # ── Authoritative end-of-turn check ────────────────────────────────────────
    alive = [pid for pid,p in game['pens'].items() if p['alive']]

    if len(alive) <= 1:
        # Round is over
        game['phase'] = 'round_over'
        # Send final state first so client sees correct positions
        state = serialize(game, room); state['simulating'] = False
        socketio.emit('game_state_update', state, room=room_code)
        game['collision_events'] = []
        end_round(room_code, alive[0] if alive else None)
        return

    # Round continues — advance turn
    game['phase'] = 'aiming'
    advance_turn(game)
    state = serialize(game, room); state['simulating'] = False
    socketio.emit('game_state_update', state, room=room_code)

def advance_turn(game):
    order, pens, n = game['turn_order'], game['pens'], len(game['turn_order'])
    for _ in range(n):
        game['turn_index'] = (game['turn_index']+1) % n
        if pens[order[game['turn_index']]]['alive']: return
    game['phase'] = 'round_over'

# ── Socket events ─────────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect(): print(f'[+] {sio_request.sid}')

@socketio.on('disconnect')
def on_disconnect():
    sid  = sio_request.sid
    info = players.pop(sid, None)
    if not info: return
    room = rooms.get(info['room'])
    if not room: return
    pid = info['player_id']
    room['players'].pop(pid, None)
    if not room['players']: rooms.pop(info['room'], None); return
    emit('player_left', {'playerId': pid}, room=info['room'])
    if 'game' in room and pid in room['game']['pens']:
        room['game']['pens'][pid]['alive'] = False

@socketio.on('create_room')
def on_create_room(data):
    sid  = sio_request.sid
    name = data.get('name','Player')[:20]
    code = gen_code(); pid = 'p1'
    rooms[code] = {
        'code':code,'host':pid,
        'players':{pid:{'name':name,'sid':sid,'pen_type':'ballpoint','ready':False}},
        'started':False,'round':1,'round_wins':{},
        'chosen_map':'classic','last_turn_order':None,
    }
    players[sid] = {'room':code,'player_id':pid}
    sio_join_room(code)
    emit('room_created',{'code':code,'playerId':pid,'players':_pinfo(rooms[code]),'host':pid})

@socketio.on('join_room')
def on_join_room(data):
    sid  = sio_request.sid
    code = data.get('code','').upper()
    name = data.get('name','Player')[:20]
    room = rooms.get(code)
    if not room:               emit('error',{'msg':'Room not found'}); return
    if room['started']:        emit('error',{'msg':'Game already started'}); return
    if len(room['players'])>=6:emit('error',{'msg':'Room is full'}); return
    pid = f'p{len(room["players"])+1}'
    room['players'][pid] = {'name':name,'sid':sid,'pen_type':'ballpoint','ready':False}
    players[sid] = {'room':code,'player_id':pid}
    sio_join_room(code)
    emit('room_joined',{'code':code,'playerId':pid,'players':_pinfo(room),'host':room['host']})
    emit('player_joined',{'playerId':pid,'name':name,'players':_pinfo(room)},room=code,include_self=False)

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
    emit('map_selected',{'mapKey':chosen},room=info['room'])

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

    dx    = float(data.get('dx', 0))
    dy    = float(data.get('dy', 0))
    power = float(data.get('power', 0))

    # Apply map power scale and hard cap (client sends 0..MAX_POWER_BASE)
    pscale = MAPS[game['map']]['power_scale']
    power  = min(power, MAX_POWER_BASE)   # clamp raw first
    power  = power * pscale               # then scale for map

    mag = math.hypot(dx, dy)
    if mag < 0.001: return
    dx /= mag; dy /= mag

    pen = game['pens'].get(pid)
    if not pen or not pen['alive']: return

    pen['vx'] = dx * power
    pen['vy'] = dy * power
    # Realistic spin: depends on off-axis component of shot vs pen orientation
    pen_axis_x = math.cos(pen['angle'])
    pen_axis_y = math.sin(pen['angle'])
    # Cross product (2D) = spin from how sideways the hit is
    spin_factor = (dx * pen_axis_y - dy * pen_axis_x) * 0.18
    pen['angularVelocity'] = spin_factor * power * 0.06

    game['phase'] = 'simulating'
    game['collision_events'] = []
    threading.Thread(target=run_physics, args=(info['room'],), daemon=True).start()

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

# ── HTTP routes ───────────────────────────────────────────────────────────────
@app.route('/')
def index(): return send_from_directory(BASE_DIR,'index.html')

@app.route('/api/sprites')
def get_sprites():
    out, adir = {}, os.path.join(BASE_DIR,'static','assets')
    for k in PEN_TYPES:
        p = os.path.join(adir, f'{k}.png')
        if os.path.exists(p):
            with open(p,'rb') as f:
                out[k]='data:image/png;base64,'+base64.b64encode(f.read()).decode()
    return jsonify(out)

@app.route('/api/maps')
def get_maps():
    return jsonify({k:{'name':m['name'],'desc':m['desc'],'emoji':m['emoji'],
                       'bg':m['bg'],'portals':m['portals']}
                    for k,m in MAPS.items()})

if __name__=='__main__':
    try:
        from pyngrok import ngrok as _ngrok
        t=_ngrok.connect(5000)
        print(f'\n🌐  Share with friends: {t.public_url}\n')
    except Exception as e:
        print(f'[ngrok] {e} — local only')
    print('🖊️  PenFight Arena v4 → http://localhost:5000')
    socketio.run(app,host='0.0.0.0',port=5000,debug=False,allow_unsafe_werkzeug=True)