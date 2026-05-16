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

# ── W class additions ─────────────────────────────────────────────────────────

# Patch W with extra entity emitters needed for the new shapes.
def _w_tor(self, a, r_major, r_minor):
    return self._e(f"TOROIDAL_SURFACE('',#{a},{_f(r_major)},{_f(r_minor)})")

def _w_fb(self, el):
    """FACE_BOUND for inner holes (.T. — orientation is ignored by the tessellator)."""
    return self._e(f"FACE_BOUND('',#{el},.T.)")

def _w_fob2(self, el, s=True):
    """FACE_OUTER_BOUND with configurable orientation flag."""
    return self._e(f"FACE_OUTER_BOUND('',#{el},{'.T.'if s else'.F.'})")

W.tor  = _w_tor
W.fb   = _w_fb
W.fob2 = _w_fob2


# ── Hollow tube (outer R=20, inner R=14, H=60) ────────────────────────────────

def gen_tube(R_outer=20., R_inner=14., H=60.):
    w = W()

    # Seam vertices
    vp_ob = w.vp(w.cp(R_outer, 0., 0.))   # outer bottom
    vp_ot = w.vp(w.cp(R_outer, 0., H))    # outer top
    vp_ib = w.vp(w.cp(R_inner, 0., 0.))   # inner bottom
    vp_it = w.vp(w.cp(R_inner, 0., H))    # inner top

    # Seam lines
    def seam_ln(w, r, vb, vt, h):
        c = w.cp(r, 0., 0.); d = w.di(0., 0., 1.)
        return w.ec(vb, vt, w.ln(c, w.vc(d, h)))

    ec_seam_o = seam_ln(w, R_outer, vp_ob, vp_ot, H)
    ec_seam_i = seam_ln(w, R_inner, vp_ib, vp_it, H)

    # Full circles at z=0 and z=H for each radius
    def circle_ec(w, vp, r, z, nz):
        o = w.cp(0., 0., z); zd = w.di(0., 0., nz); xd = w.di(1., 0., 0.)
        return w.ec(vp, vp, w.cr(w.a2p(o, zd, xd), r))

    ec_bot_o = circle_ec(w, vp_ob, R_outer, 0., -1.)
    ec_top_o = circle_ec(w, vp_ot, R_outer, H,   1.)
    ec_bot_i = circle_ec(w, vp_ib, R_inner, 0., -1.)
    ec_top_i = circle_ec(w, vp_it, R_inner, H,   1.)

    # Cylindrical surfaces
    def cyl_surf(w, r):
        o = w.cp(0.,0.,0.); z = w.di(0.,0.,1.); x = w.di(1.,0.,0.)
        return w.cyl(w.a2p(o, z, x), r)

    cs_o = cyl_surf(w, R_outer)
    cs_i = cyl_surf(w, R_inner)

    # Outer barrel (normal outward = .T.)
    oes = [w.oe(ec_seam_o,True), w.oe(ec_top_o,True), w.oe(ec_seam_o,False), w.oe(ec_bot_o,False)]
    face_outer = w.af([w.fob(w.el(oes))], cs_o)

    # Inner barrel (normal inward: reverse winding via fob2(.F.))
    oes = [w.oe(ec_seam_i,True), w.oe(ec_top_i,True), w.oe(ec_seam_i,False), w.oe(ec_bot_i,False)]
    face_inner = w.af([w.fob2(w.el(oes), False)], cs_i)

    # Annular caps: outer circle = FACE_OUTER_BOUND, inner circle = FACE_BOUND (hole)
    def annular_cap(w, ec_outer, ec_inner, z, nz):
        plane = make_plane(w, (0.,0.,z), (0.,0.,nz), (1.,0.,0.))
        fob = w.fob(w.el([w.oe(ec_outer, True)]))
        fb  = w.fb (w.el([w.oe(ec_inner, True)]))
        return w.af([fob, fb], plane)

    face_bot = annular_cap(w, ec_bot_o, ec_bot_i, 0., -1.)
    face_top = annular_cap(w, ec_top_o, ec_top_i, H,   1.)

    w.msb('tube', w.cs([face_outer, face_inner, face_bot, face_top]))
    return hdr('tube', f'KoFEM hollow tube R_outer={int(R_outer)} R_inner={int(R_inner)} H={int(H)}mm') + w.render() + ftr()


# ── 90° pipe elbow (TOROIDAL_SURFACE) ────────────────────────────────────────
# R_major = bend radius from torus axis to tube centre-line
# R_minor = tube radius

def gen_elbow(R_major=40., R_minor=10.):
    w = W()

    # Seam vertices: outermost torus point at u=0 and u=π/2
    vp_s = w.vp(w.cp(R_major + R_minor, 0., 0.))  # u=0
    vp_e = w.vp(w.cp(0., R_major + R_minor, 0.))  # u=π/2

    # Seam arc: quarter-circle in XY plane at v=0 (outermost torus circle)
    seam_cr = w.cr(w.a2p(w.cp(0.,0.,0.), w.di(0.,0.,1.), w.di(1.,0.,0.)),
                   R_major + R_minor)
    ec_seam = w.ec(vp_s, vp_e, seam_cr)   # CCW arc from u=0 to u=π/2

    # Start circle at u=0: centred at (R_major,0,0), in XZ plane
    ec_start = w.ec(vp_s, vp_s,
                    w.cr(w.a2p(w.cp(R_major,0.,0.), w.di(0.,1.,0.), w.di(1.,0.,0.)),
                         R_minor))

    # End circle at u=π/2: centred at (0,R_major,0), in YZ plane
    ec_end = w.ec(vp_e, vp_e,
                  w.cr(w.a2p(w.cp(0.,R_major,0.), w.di(1.,0.,0.), w.di(0.,1.,0.)),
                       R_minor))

    # Toroidal surface (axis = Z, centred at origin)
    tors = w.tor(w.a2p(w.cp(0.,0.,0.), w.di(0.,0.,1.), w.di(1.,0.,0.)),
                 R_major, R_minor)

    # Barrel: seam.T → end_circle.T → seam.F → start_circle.F
    oes = [w.oe(ec_seam,True), w.oe(ec_end,True), w.oe(ec_seam,False), w.oe(ec_start,False)]
    face_barrel = w.af([w.fob(w.el(oes))], tors)

    # Start cap disc: plane normal = -Y (outward from solid at u=0)
    pl_s = make_plane(w, (R_major,0.,0.), (0.,-1.,0.), (1.,0.,0.))
    face_cap_s = w.af([w.fob(w.el([w.oe(ec_start, False)]))], pl_s)

    # End cap disc: plane normal = +X (outward from solid at u=π/2)
    pl_e = make_plane(w, (0.,R_major,0.), (1.,0.,0.), (0.,1.,0.))
    face_cap_e = w.af([w.fob(w.el([w.oe(ec_end, True)]))], pl_e)

    w.msb('elbow', w.cs([face_barrel, face_cap_s, face_cap_e]))
    return hdr('elbow', f'KoFEM 90-deg pipe elbow R_major={int(R_major)} R_minor={int(R_minor)}mm') + w.render() + ftr()


# ── Half-torus U-bend (π sweep) ───────────────────────────────────────────────

def gen_torus_ring(R_major=30., R_minor=10.):
    w = W()

    vp_s = w.vp(w.cp( R_major + R_minor, 0., 0.))   # u=0
    vp_e = w.vp(w.cp(-(R_major + R_minor), 0., 0.))  # u=π

    # Seam arc: half-circle in XY plane (through +Y side)
    seam_cr = w.cr(w.a2p(w.cp(0.,0.,0.), w.di(0.,0.,1.), w.di(1.,0.,0.)),
                   R_major + R_minor)
    ec_seam = w.ec(vp_s, vp_e, seam_cr)   # CCW half-arc

    # Start circle at u=0: centred at (R_major,0,0), in XZ plane, tube axis +Y
    ec_start = w.ec(vp_s, vp_s,
                    w.cr(w.a2p(w.cp(R_major,0.,0.), w.di(0.,1.,0.), w.di(1.,0.,0.)),
                         R_minor))

    # End circle at u=π: centred at (-R_major,0,0), tube axis –Y → circle Z=(0,1,0), X=(-1,0,0)
    ec_end = w.ec(vp_e, vp_e,
                  w.cr(w.a2p(w.cp(-R_major,0.,0.), w.di(0.,1.,0.), w.di(-1.,0.,0.)),
                       R_minor))

    tors = w.tor(w.a2p(w.cp(0.,0.,0.), w.di(0.,0.,1.), w.di(1.,0.,0.)),
                 R_major, R_minor)

    oes = [w.oe(ec_seam,True), w.oe(ec_end,True), w.oe(ec_seam,False), w.oe(ec_start,False)]
    face_barrel = w.af([w.fob(w.el(oes))], tors)

    # Both end caps open toward –Y
    pl_s = make_plane(w, ( R_major,0.,0.), (0.,-1.,0.), ( 1.,0.,0.))
    face_cap_s = w.af([w.fob(w.el([w.oe(ec_start, False)]))], pl_s)

    pl_e = make_plane(w, (-R_major,0.,0.), (0., 1.,0.), (-1.,0.,0.))
    face_cap_e = w.af([w.fob(w.el([w.oe(ec_end, True)]))], pl_e)

    w.msb('torus_ring', w.cs([face_barrel, face_cap_s, face_cap_e]))
    return hdr('torus_ring', f'KoFEM half-torus U-bend R_major={int(R_major)} R_minor={int(R_minor)}mm') + w.render() + ftr()


# ── Stepped shaft (R1=20 H1=30 → R2=12 H2=40) ────────────────────────────────

def gen_stepped_shaft(R1=20., H1=30., R2=12., H2=40.):
    w = W()
    H_tot = H1 + H2

    vp_lb = w.vp(w.cp(R1, 0., 0.))     # lower bottom seam
    vp_lt = w.vp(w.cp(R1, 0., H1))     # lower top  / ring outer seam
    vp_ub = w.vp(w.cp(R2, 0., H1))     # upper bottom / ring inner seam
    vp_ut = w.vp(w.cp(R2, 0., H_tot))  # upper top seam

    def cyl_seam(w, vb, vt, r, h):
        c = w.cp(r, 0., 0.); d = w.di(0.,0.,1.)
        return w.ec(vb, vt, w.ln(c, w.vc(d, h)))

    ec_sl = cyl_seam(w, vp_lb, vp_lt, R1, H1)
    ec_su = cyl_seam(w, vp_ub, vp_ut, R2, H2)

    def full_circle(w, vp, r, z, nz):
        o = w.cp(0.,0.,z); zd = w.di(0.,0.,nz); xd = w.di(1.,0.,0.)
        return w.ec(vp, vp, w.cr(w.a2p(o, zd, xd), r))

    ec_bot  = full_circle(w, vp_lb, R1, 0.,  -1.)   # bottom cap
    ec_mid_o= full_circle(w, vp_lt, R1, H1,   1.)   # ring outer (normal +Z)
    ec_mid_i= full_circle(w, vp_ub, R2, H1,   1.)   # ring inner hole
    ec_top  = full_circle(w, vp_ut, R2, H_tot, 1.)  # top cap

    def cyl_surf(w, r):
        o = w.cp(0.,0.,0.); z = w.di(0.,0.,1.); x = w.di(1.,0.,0.)
        return w.cyl(w.a2p(o, z, x), r)

    # Bottom cap disc
    pl_bot = make_plane(w, (0.,0.,0.), (0.,0.,-1.), (1.,0.,0.))
    face_bot = w.af([w.fob(w.el([w.oe(ec_bot, True)]))], pl_bot)

    # Lower barrel
    oes = [w.oe(ec_sl,True), w.oe(ec_mid_o,True), w.oe(ec_sl,False), w.oe(ec_bot,False)]
    face_lower = w.af([w.fob(w.el(oes))], cyl_surf(w, R1))

    # Annular step ring (outer=R1, inner hole=R2, normal +Z)
    pl_ring = make_plane(w, (0.,0.,H1), (0.,0.,1.), (1.,0.,0.))
    fob_r = w.fob(w.el([w.oe(ec_mid_o, True)]))
    fb_r  = w.fb (w.el([w.oe(ec_mid_i, True)]))
    face_ring = w.af([fob_r, fb_r], pl_ring)

    # Upper barrel
    oes = [w.oe(ec_su,True), w.oe(ec_top,True), w.oe(ec_su,False), w.oe(ec_mid_i,False)]
    face_upper = w.af([w.fob(w.el(oes))], cyl_surf(w, R2))

    # Top cap disc
    pl_top = make_plane(w, (0.,0.,H_tot), (0.,0.,1.), (1.,0.,0.))
    face_top = w.af([w.fob(w.el([w.oe(ec_top, True)]))], pl_top)

    w.msb('stepped_shaft', w.cs([face_bot, face_lower, face_ring, face_upper, face_top]))
    return (hdr('stepped_shaft',
                f'KoFEM stepped shaft R1={int(R1)} H1={int(H1)} R2={int(R2)} H2={int(H2)}mm')
            + w.render() + ftr())


# ── Generic polygon extrusion ─────────────────────────────────────────────────
# profile_2d: list of (x,y) vertices, CCW when viewed from +Z

def gen_extrusion(profile_2d, D, name, desc):
    w = W()
    N = len(profile_2d)
    bot = [(x, y, 0.) for x, y in profile_2d]
    top = [(x, y, D)  for x, y in profile_2d]
    coords = bot + top   # 0..N-1 bottom, N..2N-1 top

    cps = [w.cp(*c) for c in coords]
    vps = [w.vp(c) for c in cps]

    BEs = [make_line_ec(w, coords, vps, i, (i+1)%N) for i in range(N)]
    TEs = [make_line_ec(w, coords, vps, N+i, N+(i+1)%N) for i in range(N)]
    VEs = [make_line_ec(w, coords, vps, i, N+i) for i in range(N)]
    all_ecs = BEs + TEs + VEs

    faces = []

    # Bottom cap normal = -Z: traverse edges in reverse order
    loop_bot = [(N-1-i, False) for i in range(N)]
    faces.append(face_from_loop(w, all_ecs, loop_bot,
                                make_plane(w, (0.,0.,0.), (0.,0.,-1.), (1.,0.,0.))))

    # Top cap normal = +Z: forward order
    loop_top = [(N+i, True) for i in range(N)]
    faces.append(face_from_loop(w, all_ecs, loop_top,
                                make_plane(w, (0.,0.,D), (0.,0.,1.), (1.,0.,0.))))

    # Side faces
    for i in range(N):
        p0, p1 = bot[i], bot[(i+1)%N]
        dx = p1[0]-p0[0]; dy = p1[1]-p0[1]
        length = math.sqrt(dx*dx+dy*dy)
        # Outward normal for CCW polygon: rotate edge 90° CW
        nx = dy/length; ny = -dx/length
        loop = [(i,True), (2*N+(i+1)%N,True), (N+i,False), (2*N+i,False)]
        faces.append(face_from_loop(w, all_ecs, loop,
                                    make_plane(w, p0, (nx, ny, 0.), (dx/length, dy/length, 0.))))

    w.msb(name, w.cs(faces))
    return hdr(name, desc) + w.render() + ftr()


# ── Regular hexagonal prism ───────────────────────────────────────────────────

def gen_hex_prism(R=25., H=50.):
    profile = [(R*math.cos(i*math.pi/3), R*math.sin(i*math.pi/3)) for i in range(6)]
    return gen_extrusion(profile, H, 'hex_prism',
                         f'KoFEM regular hexagonal prism circumR={int(R)} H={int(H)}mm')


# ── Square pyramid ────────────────────────────────────────────────────────────

def gen_pyramid(base=50., height=60.):
    w = W()
    bh = base/2
    # Base vertices (CCW from -Z) and apex
    base_pts = [(0.,0.,0.), (base,0.,0.), (base,base,0.), (0.,base,0.)]
    apex = (bh, bh, height)
    all_pts = base_pts + [apex]

    cps = [w.cp(*p) for p in all_pts]
    vps = [w.vp(c) for c in cps]

    # Base edges (perimeter, CCW from below)
    N = 4
    BEs = [make_line_ec(w, all_pts, vps, i, (i+1)%N) for i in range(N)]
    # Lateral edges from each base vertex to apex (index 4)
    LEs = [make_line_ec(w, all_pts, vps, i, 4) for i in range(N)]

    # Base face (normal -Z, traverse perimeter reversed)
    loop_base = [(N-1-i, False) for i in range(N)]
    faces = [face_from_loop(w, BEs + LEs, loop_base,
                             make_plane(w, (0.,0.,0.), (0.,0.,-1.), (1.,0.,0.)))]

    # Four triangular side faces
    for i in range(N):
        # Triangle: base_i → base_{i+1} → apex
        pi0 = all_pts[i]; pi1 = all_pts[(i+1)%N]; pia = all_pts[4]
        # Outward normal = cross(edge0, edge1) pointing outward
        e0 = (pi1[0]-pi0[0], pi1[1]-pi0[1], pi1[2]-pi0[2])
        e1 = (pia[0]-pi0[0], pia[1]-pi0[1], pia[2]-pi0[2])
        nx = e0[1]*e1[2]-e0[2]*e1[1]
        ny = e0[2]*e1[0]-e0[0]*e1[2]
        nz = e0[0]*e1[1]-e0[1]*e1[0]
        # For outward: cross(e0, e1) should point outward; negate if needed
        # Quick check: outward from centre (bh,bh,height/3) to face midpoint
        mx = (pi0[0]+pi1[0]+pia[0])/3 - bh
        my = (pi0[1]+pi1[1]+pia[1])/3 - bh
        mz = (pi0[2]+pi1[2]+pia[2])/3 - height/3
        if nx*mx+ny*my+nz*mz < 0:
            nx,ny,nz = -nx,-ny,-nz
        ln = math.sqrt(nx*nx+ny*ny+nz*nz)
        nx,ny,nz = nx/ln, ny/ln, nz/ln
        # X-axis: along base edge
        lx,ly,lz = e0[0]/math.sqrt(e0[0]**2+e0[1]**2+e0[2]**2), \
                   e0[1]/math.sqrt(e0[0]**2+e0[1]**2+e0[2]**2), \
                   e0[2]/math.sqrt(e0[0]**2+e0[1]**2+e0[2]**2)
        surf = make_plane(w, pi0, (nx,ny,nz), (lx,ly,lz))
        # Loop: base_edge_i forward, lateral_edge_{i+1} forward, lateral_edge_i reversed
        loop = [(i, True), (N+(i+1)%N, True), (N+i, False)]
        oes = [w.oe(BEs[lp], fw) for lp,fw in loop] if False else None
        # Build with correct indices in combined list
        all_ecs_p = BEs + LEs
        loop_s = [(i, True), (N+(i+1)%N, True), (N+i, False)]
        oes = [w.oe(all_ecs_p[j], fw) for j,fw in loop_s]
        faces.append(w.af([w.fob(w.el(oes))], surf))

    w.msb('pyramid', w.cs(faces))
    return hdr('pyramid', f'KoFEM square pyramid base={int(base)}x{int(base)} H={int(height)}mm') + w.render() + ftr()


# ── Triangular wedge (right-angle cross-section) ──────────────────────────────

def gen_wedge(length=80., width=40., height=50., depth=30.):
    # Right-triangle profile: (0,0), (length,0), (0,height) — CCW
    profile = [(0.,0.), (length,0.), (0.,height)]
    return gen_extrusion(profile, depth, 'wedge',
                         f'KoFEM triangular wedge {int(length)}x{int(width)}x{int(height)}mm')


# ── I-beam extrusion ──────────────────────────────────────────────────────────

def gen_i_beam(W_f=60., H=80., t_f=8., t_w=6., L=80.):
    hw = H - 2*t_f                       # web height
    xw = (W_f - t_w) / 2                 # flange overhang each side
    profile = [
        (0.,      0.),
        (W_f,     0.),
        (W_f,     t_f),
        (xw+t_w,  t_f),
        (xw+t_w,  t_f+hw),
        (W_f,     t_f+hw),
        (W_f,     H),
        (0.,      H),
        (0.,      t_f+hw),
        (xw,      t_f+hw),
        (xw,      t_f),
        (0.,      t_f),
    ]
    return gen_extrusion(profile, L, 'i_beam',
                         f'KoFEM I-beam W={int(W_f)} H={int(H)} tf={int(t_f)} tw={int(t_w)} L={int(L)}mm')


# ── T-profile extrusion ───────────────────────────────────────────────────────

def gen_t_profile(W_f=80., H_tot=68., t_f=8., t_w=10., L=20.):
    xw = (W_f - t_w) / 2
    profile = [
        (0.,    0.),
        (W_f,   0.),
        (W_f,   t_f),
        (xw+t_w, t_f),
        (xw+t_w, H_tot),
        (xw,    H_tot),
        (xw,    t_f),
        (0.,    t_f),
    ]
    return gen_extrusion(profile, L, 't_profile',
                         f'KoFEM T-profile W={int(W_f)} H={int(H_tot)} tf={int(t_f)} tw={int(t_w)} L={int(L)}mm')


# ── U-channel extrusion ───────────────────────────────────────────────────────

def gen_u_channel(W=60., H=40., t=5., L=80.):
    profile = [
        (0.,    0.),
        (W,     0.),
        (W,     H),
        (W-t,   H),
        (W-t,   t),
        (t,     t),
        (t,     H),
        (0.,    H),
    ]
    return gen_extrusion(profile, L, 'u_channel',
                         f'KoFEM U-channel W={int(W)} H={int(H)} t={int(t)} L={int(L)}mm')


# ── Write files ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    shapes = {
        'box.stp':           gen_box(),
        'cylinder.stp':      gen_cylinder(),
        'l_bracket.stp':     gen_l_bracket(),
        'tube.stp':          gen_tube(),
        'elbow.stp':         gen_elbow(),
        'torus_ring.stp':    gen_torus_ring(),
        'stepped_shaft.stp': gen_stepped_shaft(),
        'hex_prism.stp':     gen_hex_prism(),
        'pyramid.stp':       gen_pyramid(),
        'wedge.stp':         gen_wedge(),
        'i_beam.stp':        gen_i_beam(),
        't_profile.stp':     gen_t_profile(),
        'u_channel.stp':     gen_u_channel(),
    }
    for name, content in shapes.items():
        path = os.path.join(OUT, name)
        with open(path, 'w') as f:
            f.write(content)
        print(f'Wrote {path}  ({len(content):,} bytes)')
