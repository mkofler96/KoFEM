#!/usr/bin/env python3
"""
Generate minimal STEP AP214 test geometry files for KoFEM meshing showcase.
Produces: box.stp, cylinder.stp, l_bracket.stp
Run from repo root: python3 test_files/generate_shapes.py
"""
import math, os

OUT = os.path.dirname(os.path.abspath(__file__))

def _f(v):
    if v == int(v): return f"{int(v)}."
    return f"{v:.8g}"

class W:
    """Minimal sequential STEP entity emitter."""
    def __init__(self): self._n = 0; self._L = []
    def _e(self, b): self._n += 1; self._L.append(f"#{self._n}={b};"); return self._n
    def cp(self, x,y,z):   return self._e(f"CARTESIAN_POINT('',({_f(x)},{_f(y)},{_f(z)}))")
    def di(self, x,y,z):   return self._e(f"DIRECTION('',({_f(x)},{_f(y)},{_f(z)}))")
    def vc(self, d, m):    return self._e(f"VECTOR('',#{d},{_f(m)})")
    def vp(self, c):       return self._e(f"VERTEX_POINT('',#{c})")
    def a2p(self,o,z,x):   return self._e(f"AXIS2_PLACEMENT_3D('',#{o},#{z},#{x})")
    def pln(self, a):      return self._e(f"PLANE('',#{a})")
    def cyl(self, a, r):   return self._e(f"CYLINDRICAL_SURFACE('',#{a},{_f(r)})")
    def ln(self, c, v):    return self._e(f"LINE('',#{c},#{v})")
    def cr(self, a, r):    return self._e(f"CIRCLE('',#{a},{_f(r)})")
    def ec(self,v1,v2,cu,s=True): return self._e(f"EDGE_CURVE('',#{v1},#{v2},#{cu},{'.T.'if s else'.F.'})")
    def oe(self, ec, f=True):     return self._e(f"ORIENTED_EDGE('',*,*,#{ec},{'.T.'if f else'.F.'})")
    def el(self, oes):     return self._e(f"EDGE_LOOP('',({','.join('#'+str(x) for x in oes)}))")
    def fob(self, el):     return self._e(f"FACE_OUTER_BOUND('',#{el},.T.)")
    def af(self, bs, su, s=True):
        return self._e(f"ADVANCED_FACE('',({','.join('#'+str(x) for x in bs)}),#{su},{'.T.'if s else'.F.'})")
    def cs(self, fs):      return self._e(f"CLOSED_SHELL('',({','.join('#'+str(x) for x in fs)}))")
    def msb(self, nm, sh): return self._e(f"MANIFOLD_SOLID_BREP('{nm}',#{sh})")
    def render(self):      return '\n'.join(self._L)

def hdr(nm, desc):
    return (f"ISO-10303-21;\nHEADER;\n"
            f"FILE_DESCRIPTION(('{desc}'),'2;1');\n"
            f"FILE_NAME('{nm}.stp','',(''),(''),'KoFEM','','');\n"
            f"FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n")

def ftr(): return "\nENDSEC;\nEND-ISO-10303-21;\n"

def make_line_ec(w, coords, vps, a, b):
    """LINE EDGE_CURVE between vertex indices a, b."""
    pa, pb = coords[a], coords[b]
    dx,dy,dz = pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2]
    mag = math.sqrt(dx*dx+dy*dy+dz*dz)
    c = w.cp(*pa); d = w.di(dx/mag,dy/mag,dz/mag)
    return w.ec(vps[a], vps[b], w.ln(c, w.vc(d, mag)))

def make_plane(w, origin, normal, xaxis):
    o=w.cp(*origin); n=w.di(*normal); x=w.di(*xaxis)
    return w.pln(w.a2p(o,n,x))

def face_from_loop(w, all_ecs, loop_spec, surf_id):
    """loop_spec: list of (ec_list_idx, forward). Returns ADVANCED_FACE id."""
    oes = [w.oe(all_ecs[i], fwd) for i,fwd in loop_spec]
    return w.af([w.fob(w.el(oes))], surf_id)

# ── Box 80×60×40 mm ──────────────────────────────────────────────────────────

def gen_box():
    w = W()
    coords = [
        (0,0,0),(80,0,0),(80,60,0),(0,60,0),    # 0-3 bottom
        (0,0,40),(80,0,40),(80,60,40),(0,60,40), # 4-7 top
    ]
    cps = [w.cp(*c) for c in coords]
    vps = [w.vp(c) for c in cps]

    # 12 edge curves: bottom(0-3) top(4-7) vertical(8-11)
    ev = [(0,1),(1,2),(2,3),(3,0),(4,5),(5,6),(6,7),(7,4),
          (0,4),(1,5),(2,6),(3,7)]
    ecs = [make_line_ec(w, coords, vps, a, b) for a,b in ev]

    # face: (loop_as_list_of_(ec_idx,fwd), normal, origin, xaxis)
    face_specs = [
        ([(3,False),(2,False),(1,False),(0,False)], (0,0,-1),(0,0,0),(1,0,0)),  # bottom
        ([(4,True),(5,True),(6,True),(7,True)],     (0,0, 1),(0,0,40),(1,0,0)), # top
        ([(0,True),(9,True),(4,False),(8,False)],   (0,-1,0),(0,0,0),(1,0,0)),  # front
        ([(1,True),(10,True),(5,False),(9,False)],  (1,0,0),(80,0,0),(0,1,0)),  # right
        ([(2,True),(11,True),(6,False),(10,False)], (0,1,0),(0,60,0),(1,0,0)),  # back
        ([(8,True),(7,False),(11,False),(3,True)],  (-1,0,0),(0,0,0),(0,1,0)), # left
    ]
    faces = []
    for loop,nrm,org,xax in face_specs:
        s = make_plane(w, org, nrm, xax)
        faces.append(face_from_loop(w, ecs, loop, s))

    w.msb('box', w.cs(faces))
    return hdr('box','KoFEM test box 80x60x40mm') + w.render() + ftr()

# ── Cylinder R=25 H=80 ───────────────────────────────────────────────────────

def gen_cylinder(R=25., H=80.):
    w = W()

    # Two vertex points (one on bottom circle, one on top)
    cp_b = w.cp(R,0.,0.);  vp_b = w.vp(cp_b)
    cp_t = w.cp(R,0.,H);   vp_t = w.vp(cp_t)

    # Seam: vertical line from bottom to top vertex
    sc = w.cp(R,0.,0.); sd = w.di(0.,0.,1.)
    ec_seam = w.ec(vp_b, vp_t, w.ln(sc, w.vc(sd, H)))

    # Bottom circle (full, closed, start=end=vp_b)
    bo = w.cp(0.,0.,0.); bz = w.di(0.,0.,-1.); bx = w.di(1.,0.,0.)
    ec_bot = w.ec(vp_b, vp_b, w.cr(w.a2p(bo,bz,bx), R))

    # Top circle (full, closed, start=end=vp_t)
    to = w.cp(0.,0.,H); tz = w.di(0.,0.,1.); tx = w.di(1.,0.,0.)
    ec_top = w.ec(vp_t, vp_t, w.cr(w.a2p(to,tz,tx), R))

    # Bottom cap: single circle loop
    oes = [w.oe(ec_bot, True)]
    bp  = make_plane(w, (0.,0.,0.), (0.,0.,-1.), (1.,0.,0.))
    face_bot = w.af([w.fob(w.el(oes))], bp)

    # Top cap: single circle loop
    oes = [w.oe(ec_top, True)]
    tp  = make_plane(w, (0.,0.,H), (0.,0.,1.), (1.,0.,0.))
    face_top = w.af([w.fob(w.el(oes))], tp)

    # Lateral face: seam.T → top_circle.T → seam.F → bottom_circle.F
    oes = [w.oe(ec_seam,True), w.oe(ec_top,True), w.oe(ec_seam,False), w.oe(ec_bot,False)]
    cso = w.cp(0.,0.,0.); csz = w.di(0.,0.,1.); csx = w.di(1.,0.,0.)
    cs  = w.cyl(w.a2p(cso,csz,csx), R)
    face_lat = w.af([w.fob(w.el(oes))], cs)

    w.msb('cylinder', w.cs([face_bot, face_top, face_lat]))
    return hdr('cylinder',f'KoFEM test cylinder R={int(R)} H={int(H)}mm') + w.render() + ftr()

# ── L-bracket ─────────────────────────────────────────────────────────────────
# Horiz arm 80×25, vert arm 30×80, depth D=20 (all mm)
# CCW cross-section profile (from +Z): B0(0,0)→B1(80,0)→B2(80,25)→B3(30,25)→B4(30,80)→B5(0,80)

def gen_l_bracket(D=20.):
    w = W()
    N = 6  # polygon vertices
    profile = [(0,0),(80,0),(80,25),(30,25),(30,80),(0,80)]

    bot = [(x,y,0.) for x,y in profile]
    top = [(x,y,D) for x,y in profile]
    coords = bot + top   # 0-5 bottom, 6-11 top

    cps = [w.cp(*c) for c in coords]
    vps = [w.vp(c) for c in cps]

    # Perimeter bottom edges: BEs[i] = bot_i → bot_{i+1}%N  (indices 0..N-1)
    BEs = [make_line_ec(w, coords, vps, i, (i+1)%N) for i in range(N)]
    # Perimeter top edges:  TEs[i] = top_i → top_{i+1}%N  (indices N..2N-1)
    TEs = [make_line_ec(w, coords, vps, N+i, N+(i+1)%N) for i in range(N)]
    # Vertical edges:       VEs[i] = bot_i → top_i          (indices 2N..3N-1)
    VEs = [make_line_ec(w, coords, vps, i, N+i) for i in range(N)]

    # Flat all-EC list indexed as: 0..N-1=BEs, N..2N-1=TEs, 2N..3N-1=VEs
    all_ecs = BEs + TEs + VEs

    faces = []

    # Bottom cap (normal=-Z): CCW from -Z = B0→B5→B4→B3→B2→B1
    # BEs[(N-1-i)] reversed for i in 0..N-1
    loop_bot = [(N-1-i, False) for i in range(N)]
    s = make_plane(w, (0,0,0), (0,0,-1), (1,0,0))
    faces.append(face_from_loop(w, all_ecs, loop_bot, s))

    # Top cap (normal=+Z): CCW from +Z = T0→T1→T2→T3→T4→T5
    loop_top = [(N+i, True) for i in range(N)]
    s = make_plane(w, (0,0,D), (0,0,1), (1,0,0))
    faces.append(face_from_loop(w, all_ecs, loop_top, s))

    # Side faces: face i = Bi → B{i+1} → T{i+1} → Ti
    # Loop: [BEs[i].T, VEs[(i+1)%N].T, TEs[i].F, VEs[i].F]
    # In all_ecs indices: [i.T, 2N+(i+1)%N.T, N+i.F, 2N+i.F]
    side_normals = [
        (0,-1,0),   # SF0: y=0  front
        (1,0,0),    # SF1: x=80 right
        (0,1,0),    # SF2: y=25 step top
        (1,0,0),    # SF3: x=30 inner right
        (0,1,0),    # SF4: y=80 back
        (-1,0,0),   # SF5: x=0  left
    ]
    side_origins = [
        (0,0,0),(80,0,0),(30,25,0),(30,25,0),(0,80,0),(0,0,0)
    ]
    side_xaxes = [
        (1,0,0),(0,1,0),(1,0,0),(0,1,0),(1,0,0),(0,1,0)
    ]
    for i in range(N):
        loop = [
            (i, True),
            (2*N + (i+1)%N, True),
            (N + i, False),
            (2*N + i, False),
        ]
        s = make_plane(w, side_origins[i], side_normals[i], side_xaxes[i])
        faces.append(face_from_loop(w, all_ecs, loop, s))

    w.msb('l_bracket', w.cs(faces))
    return hdr('l_bracket','KoFEM L-bracket 80x80x20mm') + w.render() + ftr()

# ── Write files ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    shapes = {
        'box.stp':       gen_box(),
        'cylinder.stp':  gen_cylinder(),
        'l_bracket.stp': gen_l_bracket(),
    }
    for name, content in shapes.items():
        path = os.path.join(OUT, name)
        with open(path, 'w') as f:
            f.write(content)
        print(f'Wrote {path}  ({len(content):,} bytes)')
