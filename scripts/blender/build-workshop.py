"""Author the underground service bay in Blender 5.2 and export engine-native meshes.

Run: blender --background --factory-startup --python-exit-code 1
             --python scripts/blender/build-workshop.py
The live MCP connection was verified; the user requested an independent headless
process so their interactive Blender may stay closed while this source builds.
Only the scene named TMT • Service Bay 03 and its own data are replaced. Existing scenes
are preserved. Coordinates in this source are game Y-up; Blender receives (x,-z,y).
Selected procedural metal albedo is sampled from the image-generated atlas into
linear vertex RGB; masonry, concrete, painted fixtures and brass use the runtime
world-space texture materials. Meshy props retain every original triangle,
normal and UV in material 13. Native PBR maps are archived unchanged while the
shipping package uses the separately measured WebP texture pipeline.
"""
import array
import json
import math
import os
import random
import shutil
import struct
from collections import defaultdict

import bpy
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'workshop')
SOURCE = os.path.join(ROOT, 'assets', 'workshop')
TEXTURE_SOURCE = os.path.join(SOURCE,'texture-source')
SCENE_NAME = 'TMT • Service Bay 03'
PREFIX = 'TMT_WS_'
RNG = random.Random(3052)
TAU = math.tau


def clear_saved_browser_paths():
    # Dormant file-browser editors retain a workstation's Documents directory.
    for screen in bpy.data.screens:
        for area in screen.areas:
            for space in area.spaces:
                if space.type == 'FILE_BROWSER' and space.params:
                    space.params.directory = b'//'


def V(v):
    return Vector(v)


def blender(v):
    return (v[0], -v[2], v[1])


def linear(v):
    return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4


class Author:
    def __init__(self):
        self.batches = defaultdict(lambda: {'p': [], 'n': [], 'c': [], 'a': [], 'i': []})
        self.fan_batches = {}
        self.names = defaultdict(int)
        self.group = 'architecture'
        self.tint = (1., 1., 1.)
        self.disabled = set()
        self.textures = []
        self.imported_materials = []
        self.prop_layers = {}
        self.steam_vent = [5.06,3.32,-5.73]
        self.atlas = bpy.data.images.load(os.path.join(SOURCE, 'materials-atlas.png'), check_existing=True)
        self.width, self.height = self.atlas.size
        self.pixels = array.array('f', [0.]) * (self.width * self.height * 4)
        self.atlas.pixels.foreach_get(self.pixels)
        self.atlas.pack()

    def color(self, p, n, material):
        if material in (18,19):return tuple(p)
        if material not in (9, 10, 11, 12):
            return self.tint
        # Dominant-axis projection, consistent across adjacent mesh faces. Bake
        # at vertices: the art contributes restrained variation, never lighting.
        axis = max(range(3), key=lambda i: abs(n[i]))
        u, v = ((p[2], p[1]), (p[0], p[2]), (p[0], p[1]))[axis]
        scale = 1.4 if material == 9 else 2.2
        u = (u * scale) % 1.
        v = (v * scale) % 1.
        qx = 0 if material in (9, 11) else 1
        qy = 1 if material in (9, 10) else 0
        x = int((qx * .5 + .018 + u * .464) * (self.width - 1))
        y = int((qy * .5 + .018 + v * .464) * (self.height - 1))
        idx = (y * self.width + x) * 4
        # bpy image pixels for PNG are scene linear already only when accessed
        # as float? Image.pixels exposes encoded values for regular byte images;
        # explicitly convert sRGB for the engine's linear authored albedo.
        samples = [linear(max(0, min(1, self.pixels[idx + j]))) for j in range(3)]
        gain = {9: 1.12, 10: 1.6, 11: 1.15, 12: 1.15}[material]
        if material==9:
            # Controlled mineral discoloration: clean, readable surfaces in the
            # working area, darker moisture staining at masonry footings.
            gain*=.82+.18*min(1,max(0,p[1]/1.25))
            if abs(n[1])>.9 and p[1]<.1:gain*=.88+.12*(.5+.5*math.sin(p[0]*.91+p[2]*.61))
        return tuple(min(.85, max(.012, samples[j] * gain * self.tint[j])) for j in range(3))

    def face(self, points, material=10, outward=None, normals=None, subdivide=True, colors=None):
        if self.group in self.disabled:
            return
        if material==11:material=19
        if material==9:
            if self.group=='poured concrete service floor':material=16
            elif self.group in ('bonded brick side walls','bonded brick vaulted end walls'):material=15
            elif self.group in ('vaulted basalt shell','fitted stone voussoirs','exposed excavated basalt outcrops'):material=17
        pts = [V(p) for p in points]
        n = (pts[1] - pts[0]).cross(pts[2] - pts[0]).normalized()
        if outward is not None and n.dot(V(outward)) < 0:
            pts.reverse()
            if normals:
                normals = list(reversed(normals))
            if colors:
                colors = list(reversed(colors))
            n.negate()
        # Tiny non-planar wear belongs to each exposed clay/stone face, above
        # the fine authored bump. Keep all mortar and bed edges unchanged.
        # The millimetre relief catches grazing light without rounded pillows.
        if len(pts)==4 and material in (15,17):
            centre=sum(pts,V((0,0,0)))/4
            visible_brick=material==15 and n.dot(centre)<-1
            visible_vault=material==17 and self.group=='fitted stone voussoirs' and abs(n.z)<.1 and n.dot(centre-V((0,3.3,0)))<0
            if visible_brick or visible_vault:
                relief=RNG.uniform(-.001,.0045) if visible_brick else RNG.uniform(-.003,.007)
                peak=centre+n*relief+(pts[1]-pts[0])*RNG.uniform(-.12,.12)+(pts[3]-pts[0])*RNG.uniform(-.12,.12)
                for j in range(4):self.face([pts[j],pts[(j+1)%4],peak],material,n,subdivide=False)
                return
        # Broad masonry faces carry enough vertices for the image-authored
        # basalt veins and mineral variation to survive the runtime bake.
        if subdivide and material == 9 and len(pts) == 4 and (pts[1]-pts[0]).cross(pts[3]-pts[0]).length > .5:
            steps = 2
            def bilinear(u,v):
                return pts[0]*(1-u)*(1-v)+pts[1]*u*(1-v)+pts[2]*u*v+pts[3]*(1-u)*v
            for yy in range(steps):
                for xx in range(steps):
                    self.face([bilinear(xx/steps,yy/steps),bilinear((xx+1)/steps,yy/steps),bilinear((xx+1)/steps,(yy+1)/steps),bilinear(xx/steps,(yy+1)/steps)],material,n,subdivide=False)
            return
        batch = self.batches[material]
        start = len(batch['a'])
        for j, p in enumerate(pts):
            vn = V(normals[j]) if normals else n
            batch['p'].extend(p)
            batch['n'].extend(vn)
            batch['c'].extend(colors[j] if colors else self.color(p, vn, material))
            batch['a'].append((material << 16) | (238 << 8) | 40)
        for i in range(1, len(pts) - 1):
            batch['i'].extend((start, start + i, start + i + 1))
        self.names[self.group] += len(pts) - 2

    def box(self, centre, size, material=10, bevel=.035, rotation=None):
        centre = V(centre)
        half = V(size) * .5
        b = min(bevel, min(half) * .4)
        mat = rotation or Matrix.Identity(3)
        corners = {}
        for x in (-1, 1):
            for y in (-1, 1):
                for z in (-1, 1):
                    signs = (x, y, z)
                    for axis in range(3):
                        corners[(x, y, z, axis)] = V(tuple(signs[i] * (half[i] if i == axis else half[i] - b) for i in range(3)))
        def f(coords, outward):
            self.face([centre + mat @ p for p in coords], material, mat @ V(outward))
        for axis in range(3):
            a, c = [i for i in range(3) if i != axis]
            for s in (-1, 1):
                coords = []
                for sa, sc in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    signs = [0, 0, 0]
                    signs[axis], signs[a], signs[c] = s, sa, sc
                    coords.append(corners[(*signs, axis)])
                normal = [0, 0, 0]
                normal[axis] = s
                f(coords, normal)
        if b < .00001:
            return
        for axis in range(3):
            a, c = [i for i in range(3) if i != axis]
            for sa in (-1, 1):
                for sc in (-1, 1):
                    lo, hi = [0, 0, 0], [0, 0, 0]
                    lo[axis], hi[axis] = -1, 1
                    lo[a] = hi[a] = sa
                    lo[c] = hi[c] = sc
                    normal = [0, 0, 0]
                    normal[a], normal[c] = sa, sc
                    f([corners[(*lo, a)], corners[(*hi, a)], corners[(*hi, c)], corners[(*lo, c)]], normal)
        for x in (-1, 1):
            for y in (-1, 1):
                for z in (-1, 1):
                    f([corners[(x, y, z, axis)] for axis in range(3)], (x, y, z))

    def cylinder(self, a, b, radius, material=10, sides=12, end_radius=None, cap=True):
        a, b = V(a), V(b)
        d = (b - a).normalized()
        reference = V((0, 1, 0)) if abs(d.y) < .9 else V((1, 0, 0))
        u = d.cross(reference).normalized()
        v = d.cross(u).normalized()
        er = radius if end_radius is None else end_radius
        ring_a, ring_b = [], []
        normals = []
        for i in range(sides):
            angle = i / sides * TAU
            n = u * math.cos(angle) + v * math.sin(angle)
            normals.append(n)
            ring_a.append(a + n * radius)
            ring_b.append(b + n * er)
        for i in range(sides):
            j = (i + 1) % sides
            self.face([ring_a[i], ring_a[j], ring_b[j], ring_b[i]], material, normals[i], [normals[i], normals[j], normals[j], normals[i]])
        if cap:
            self.face(ring_a, material, -d)
            self.face(ring_b, material, d)

    def beam(self, a, b, width, depth, material=10, bevel=.015):
        a, b = V(a), V(b)
        axis = (b - a).normalized()
        ref = V((0, 1, 0)) if abs(axis.y) < .95 else V((1, 0, 0))
        x = axis.cross(ref).normalized()
        y = axis.cross(x).normalized()
        mat = Matrix((x, y, axis)).transposed()
        self.box((a + b) * .5, (width, depth, (b-a).length), material, bevel, mat)

    def torus(self, centre, radius, tube=.025, material=11, axis=(0, 0, 1), major=20, minor=6):
        c, d = V(centre), V(axis).normalized()
        ref = V((0, 1, 0)) if abs(d.y) < .9 else V((1, 0, 0))
        u = d.cross(ref).normalized()
        v = d.cross(u).normalized()
        pts, norms = [], []
        for i in range(major):
            row, nr = [], []
            t = i / major * TAU
            radial = u * math.cos(t) + v * math.sin(t)
            for j in range(minor):
                q = j / minor * TAU
                n = radial * math.cos(q) + d * math.sin(q)
                row.append(c + radial * radius + n * tube)
                nr.append(n)
            pts.append(row)
            norms.append(nr)
        for i in range(major):
            for j in range(minor):
                ni, nj = (i+1) % major, (j+1) % minor
                self.face([pts[i][j], pts[ni][j], pts[ni][nj], pts[i][nj]], material, normals=[norms[i][j], norms[ni][j], norms[ni][nj], norms[i][nj]])

    def bolt(self, p, axis=(0, 0, 1), size=.045, material=11):
        p, axis = V(p), V(axis)
        self.cylinder(p-axis*.01, p+axis*.025, size*1.25, 10, 10)
        self.cylinder(p+axis*.023, p+axis*.056, size, material, 6)

    def rock(self,p,size):
        p=V(p);size=V(size)
        rings=[]
        for y,r in ((-.5,.57),(-.18,1.),(.25,.9),(.5,.52)):
            rings.append([p+V((math.cos(i/8*TAU)*r*RNG.uniform(.83,1.05)*size.x,y*size.y,math.sin(i/8*TAU)*r*RNG.uniform(.83,1.05)*size.z)) for i in range(8)])
        self.face(rings[0],9,(0,-1,0),subdivide=False)
        self.face(rings[-1],9,(0,1,0),subdivide=False)
        for j in range(3):
            for i in range(8):
                ni=(i+1)%8
                pts=[rings[j][i],rings[j][ni],rings[j+1][ni],rings[j+1][i]]
                self.face(pts,9,(pts[0]+pts[1])*.5-p,subdivide=False)

    def pipe(self, points, radius=.09, material=12, flanges=True):
        points=[V(p) for p in points]
        if len(points)<2:return
        path=[(points[0],(points[1]-points[0]).normalized())]
        couplings=[]
        for i in range(1,len(points)-1):
            p=points[i];incoming=(p-points[i-1]).normalized();outgoing=(points[i+1]-p).normalized()
            theta=math.acos(max(-1,min(1,incoming.dot(outgoing))))
            if theta<.0001:
                path.append((p,incoming));continue
            axis=incoming.cross(outgoing).normalized()
            trim=min(radius*2.7*math.tan(theta*.5),(p-points[i-1]).length*.34,(points[i+1]-p).length*.34)
            bend_radius=trim/math.tan(theta*.5)
            start=p-incoming*trim;end=p+outgoing*trim
            centre=start+axis.cross(incoming)*bend_radius
            radial=start-centre
            steps=max(4,math.ceil(theta/(math.pi/24)))
            for step in range(steps+1):
                turn=Matrix.Rotation(theta*step/steps,3,axis)
                path.append((centre+turn@radial,turn@incoming))
            couplings.extend(((start-incoming*radius*.32,incoming),(end+outgoing*radius*.32,outgoing)))
        path.append((points[-1],(points[-1]-points[-2]).normalized()))
        # A continuously swept circular tube gives tangent elbows and smooth
        # normals, with no intersecting cylinders or axis-aligned joint boxes.
        rings=[];normals=[];previous=None;sides=16
        for p,tangent in path:
            ref=V((0,1,0)) if abs(tangent.y)<.9 else V((1,0,0))
            u=tangent.cross(ref).normalized() if previous is None else (previous-tangent*previous.dot(tangent)).normalized()
            if u.length<.1:u=tangent.cross(ref).normalized()
            v=tangent.cross(u).normalized();previous=u
            normal=[u*math.cos(j/sides*TAU)+v*math.sin(j/sides*TAU) for j in range(sides)]
            rings.append([p+n*radius for n in normal]);normals.append(normal)
        for i in range(len(rings)-1):
            for j in range(sides):
                k=(j+1)%sides
                self.face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],material,normals=[normals[i][j],normals[i][k],normals[i+1][k],normals[i+1][j]])
        self.face(rings[0],material,-path[0][1]);self.face(rings[-1],material,path[-1][1])
        if flanges:
            for p,d in couplings:self.flange(p,d,radius)
        if flanges:
            for index in (0, len(points)-1):
                p = V(points[index])
                d = (V(points[1])-p).normalized() if index == 0 else (p-V(points[-2])).normalized()
                self.flange(p, d, radius)

    def flange(self, p, d, radius):
        p, d = V(p), V(d).normalized()
        self.cylinder(p-d*.045, p+d*.045, radius*1.65, 11, 16)
        ref = V((0,1,0)) if abs(d.y)<.9 else V((1,0,0))
        u=d.cross(ref).normalized();v=d.cross(u).normalized()
        for i in range(6):
            point=p+(u*math.cos(i/6*TAU)+v*math.sin(i/6*TAU))*radius*1.35
            self.bolt(point+d*.04, d, radius*.16)

    def gauge(self, p, radius=.23, facing=(0,0,1), reading=.65):
        p, d=V(p),V(facing).normalized()
        self.cylinder(p-d*.07,p+d*.045,radius*1.08,11,24)
        self.tint=(.8,.82,.74)
        self.cylinder(p+d*.046,p+d*.051,radius*.87,9,24)
        self.tint=(1,1,1)
        self.torus(p+d*.055,radius*.92,.016,11,d,24,5)
        ref=V((0,1,0)) if abs(d.y)<.9 else V((1,0,0))
        u=d.cross(ref).normalized();v=d.cross(u).normalized()
        for i in range(13):
            t=(i/12*1.5-.75)*math.pi
            radial=u*math.sin(t)+v*math.cos(t)
            self.beam(p+d*.06+radial*radius*.64,p+d*.06+radial*radius*.8,.008,.008,10,0)
        t=(reading*1.5-.75)*math.pi
        self.beam(p+d*.074,p+d*.074+(u*math.sin(t)+v*math.cos(t))*radius*.66,.014,.012,12,.004)
        self.cylinder(p+d*.06,p+d*.087,radius*.085,11,8)

    def wheel(self,p,radius=.3,axis=(0,0,1),material=12):
        p,d=V(p),V(axis).normalized()
        self.torus(p,radius,.028,material,d,20,6)
        ref=V((0,1,0)) if abs(d.y)<.9 else V((1,0,0))
        u=d.cross(ref).normalized();v=d.cross(u).normalized()
        for i in range(4):
            self.cylinder(p,p+(u*math.cos(i/4*TAU)+v*math.sin(i/4*TAU))*radius,.018,material,6)
        self.cylinder(p-d*.08,p+d*.04,.055,11,10)

    def arch(self,z,steel=False):
        count=24 if steel else 36
        for i in range(count):
            gap=.0025 if steel else .00085
            a=-math.pi/2+i/count*math.pi+gap
            b=-math.pi/2+(i+1)/count*math.pi-gap
            if not steel:self.tint=(RNG.uniform(.88,1.0),)*3
            rx,ry=(6.73,4.03) if steel else (7.,4.2)
            thick=.18 if steel else .32
            depth=.23 if steel else .488
            verts=[]
            for zz in (z-depth/2,z+depth/2):
                for r in (0,thick):
                    for t in (a,b):
                        verts.append(V(((rx+r)*math.sin(t),3.3+(ry+r)*math.cos(t),zz)))
            centre=sum(verts,V((0,0,0)))/8
            for face in ((0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)):
                pts=[verts[j] for j in face]
                self.face(pts,10 if steel else 9,sum(pts,V((0,0,0)))/4-centre)
            if steel:
                t=(a+b)/2
                for side in (-1,1):
                    self.bolt(((rx-.005)*math.sin(t),3.3+(ry-.005)*math.cos(t),z+side*.128),(0,0,side),.046)

    def text(self,scene,value,position,size=.5,material=11,rotation=(math.pi/2,0,0)):
        curve=bpy.data.curves.new(PREFIX+'type_'+value,'FONT')
        curve.body=value;curve.size=size;curve.extrude=.008;curve.bevel_depth=.002;curve.bevel_resolution=0;curve.resolution_u=3
        curve.align_x='CENTER'
        obj=bpy.data.objects.new(PREFIX+'type_'+value,curve)
        scene.collection.objects.link(obj)
        obj.location=blender(position);obj.rotation_euler=rotation
        deps=bpy.context.evaluated_depsgraph_get()
        evaluated=obj.evaluated_get(deps)
        mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        for tri in mesh.loop_triangles:
            pts=[]
            for vi in tri.vertices:
                v=obj.matrix_world@mesh.vertices[vi].co
                pts.append((v.x,v.z,-v.y))
            self.face(pts,material)
        evaluated.to_mesh_clear();bpy.data.objects.remove(obj,do_unlink=True);bpy.data.curves.remove(curve)


def outside_fan_aperture(points):
    """Partition a convex XY polygon around the 48-sided circular duct mouth."""
    inside=points
    outside=[]
    for i in range(48):
        theta=(i+.5)/48*TAU
        nx,ny=math.cos(theta),math.sin(theta)
        # Masonry must clear the duct's OUTER shell. Cutting on its inner radius
        # put the brick reveal exactly on the steel liner and caused Z-fighting.
        distance=1.55*math.cos(math.pi/48)
        def split(poly,keep_inside):
            result=[]
            for j,p in enumerate(poly):
                q=poly[(j+1)%len(poly)]
                dp=p[0]*nx+(p[1]-4.22)*ny-distance
                dq=q[0]*nx+(q[1]-4.22)*ny-distance
                pin=dp<=0 if keep_inside else dp>=0
                qin=dq<=0 if keep_inside else dq>=0
                if pin:result.append(p)
                if pin!=qin:
                    t=dp/(dp-dq)
                    result.append(tuple(p[k]+(q[k]-p[k])*t for k in range(len(p))))
            return result
        if len(inside)<3:break
        piece=split(inside,False)
        if len(piece)>=3:outside.append(piece)
        inside=split(inside,True)
    return outside


def architecture(a):
    a.group='vaulted basalt shell'
    # Solid backing caps close every joint at both vaulted ends; the individual
    # masonry courses and shutter sit in front. No camera-visible ceiling gap.
    for z,outward in ((-9.0,(0,0,1)),(9.09,(0,0,-1))):
        points=[(-7.18,0,z),(7.18,0,z),(7.18,3.3,z)]
        for i in range(1,33):
            t=i/32*math.pi
            points.append((7.18*math.cos(t),3.3+4.38*math.sin(t),z))
        for polygon in outside_fan_aperture(points) if z<0 else [points]:
            a.face(polygon,9,outward,subdivide=False)
    # Continuous poured concrete around a real recessed lift pit. The dynamic
    # lowered deck closes this hole at floor datum; no floor crosses its links.
    a.group='poured concrete service floor'
    a.tint=(.96,.98,1)
    for x in (-4.435,4.435):a.box((x,-.13,0),(5.43,.26,18.3),9,0)
    for z in (-5.625,5.625):a.box((0,-.13,z),(3.44,.26,7.05),9,0)
    # Start below the slab: duplicate co-planar wall tops/upper reveals would
    # blacken the floor edge and shimmer against the slab's own vertical faces.
    for x in (-1.84,1.84):a.box((x,-.49,0),(.24,.46,4.2),16,0)
    for z in (-2.22,2.22):a.box((0,-.49,z),(3.44,.46,.24),16,0)
    a.tint=(.58,.62,.66)
    a.box((0,-.765,0),(3.44,.09,4.2),16,0)
    a.tint=(1,1,1)
    a.group='recessed service pit rim and drainage'
    for x in (-1.585,1.585):
        # Fixed cover plates end25mm clear of the moving2.85m deck.
        a.box((x,-.014,0),(.27,.028,4.20),10,.004)
        a.box(((-1 if x<0 else 1)*1.695,-.058,0),(.025,.09,4.13),10,.003)
    for z in (-2.0375,2.0375):
        a.box((0,-.014,z),(2.90,.028,.125),10,.004)
        a.box((0,-.058,(-1 if z<0 else 1)*2.075),(2.87,.09,.025),10,.003)
    a.box((1.42,-.716,1.80),(.31,.012,.34),10,.009)
    for i in range(5):a.box((1.30+i*.06,-.705,1.8),(.027,.008,.30),10,.002)
    def brick_tint():
        palette=((1,.94,.89),(.91,.9,.88),(.96,.93,.88),(.93,.89,.85),(.88,.91,.95))
        base=palette[RNG.randrange(len(palette))];variation=RNG.uniform(.95,1.04)
        return tuple(c*variation for c in base)
    a.group='bonded brick side walls'
    for side in (-1,1):
        a.tint=(.68,.65,.6)
        a.box((side*7.145,1.65,0),(.36,3.3,18.15),17,.002)
        for row in range(16):
            bottom=row*.212;height=min(.2,3.3-bottom)
            z=-9.0-(.246 if row%2 else 0)
            while z<9:
                lo=max(-9,z);hi=min(9,z+.48)
                if hi-lo>.03:
                    a.tint=brick_tint()
                    a.box((side*7.04,bottom+height/2,(lo+hi)/2),(.20,height-.006,hi-lo),9,.006)
                z+=.492
        a.tint=(1,1,1)
        # Robust iron plinth and top cornice.
        a.box((side*6.89,.19,0),(.18,.32,18),10,.025)
        a.box((side*6.94,3.25,0),(.18,.18,18),11,.018)
    a.tint=(1,1,1)
    a.group='fitted stone voussoirs'
    for row in range(36):
        a.tint=(.95+RNG.random()*.18,)*3
        a.arch(-8.75+row*.5)
    # Real brick dimensions and a half-brick running bond, with recessed mortar.
    # End courses clip to the elliptical vault and the freight shutter opening.
    a.group='bonded brick vaulted end walls'
    for z,front in ((-8.97,False),(9.0,True)):
        a.tint=(.68,.65,.6)
        if front:
            a.box((0,1.65,z+.04),(14.25,3.3,.19),17,.002)
        # The rear cap above already supplies the recessed mortar backing;
        # a second full rectangle would seal the lower edge of the fan duct.
        for row in range(36):
            y=row*.212+.10
            maxx=7 if y<3.3 else 7*math.sqrt(max(0,1-((y-3.3)/4.2)**2))
            x=-maxx-(.246 if row%2 else 0)
            while x<maxx:
                lo=max(-maxx,x);hi=min(maxx,x+.48)
                if hi-lo>.03 and not(front and y<4.4 and lo<3.55 and hi>-3.55):
                    a.tint=brick_tint()
                    if not front and lo<1.57 and hi>-1.57 and y>2.57 and y<5.88:
                        rectangle=[(lo,y-.097),(hi,y-.097),(hi,y+.097),(lo,y+.097)]
                        for polygon in outside_fan_aperture(rectangle):
                            for zz,n in ((z-.11,(0,0,-1)),(z+.11,(0,0,1))):
                                a.face([(xx,yy,zz) for xx,yy in polygon],9,n,subdivide=False)
                            for j,p in enumerate(polygon):
                                q=polygon[(j+1)%len(polygon)]
                                a.face([(p[0],p[1],z-.11),(q[0],q[1],z-.11),(q[0],q[1],z+.11),(p[0],p[1],z+.11)],9,(q[1]-p[1],p[0]-q[0],0),subdivide=False)
                    else:
                        a.box(((lo+hi)/2,y,z),(hi-lo,.194,.22),9,.006)
                x+=.492
    a.tint=(1,1,1)
    a.group='exposed excavated basalt outcrops'
    for side in (-1,1):
        for i in range(5):
            a.tint=(.75,.85,.93)
            a.rock((side*(6.77+(i%2)*.1),.55+i*.62,-8.52),(.53,.91,.56))
        # Only irregular corner remnants expose the excavation. The full fan
        # surround remains bonded red brick, with no slab-like rock overlays.
    a.tint=(1,1,1)
    a.group='riveted steel structural ribs'
    for z in (-7.8,-4.6,-1.4,1.8,5,8.2):
        a.arch(z,True)
        for side in (-1,1):
            a.box((side*6.72,1.65,z),(.27,3.3,.24),10,.023)
            for zz in (-.18,.18):
                a.box((side*6.72,1.65,z+zz),(.52,3.3,.09),10,.017)
            a.box((side*6.72,.16,z),(.85,.25,.84),10,.04)
            a.box((side*6.72,3.24,z),(.78,.25,.74),10,.02)
            for y in (.46,1.08,1.7,2.32,2.94):
                for dx in (-.16,.16):
                    a.bolt((side*6.72+dx,y,z+.238),size=.047)
            for dx in (-.3,.3):
                for dz in (-.3,.3):a.bolt((side*6.72+dx,.3,z+dz),(0,1,0),.055)
    # Higher catwalk and structural cross ties add meaningful vertical scale.
    for z in (-6.2,6.7):
        a.box((0,4.96,z),(12.7,.22,.18),10,.02)
        for x in (-5,-3,-1,1,3,5):
            a.beam((x-.9,4.96,z),(x+.9,5.65,z),.07,.07,10)
            a.beam((x-.9,5.65,z),(x+.9,4.96,z),.07,.07,10)
        a.box((0,5.65,z),(12.7,.15,.15),10,.02)
    a.group='flush boiler sump drain'
    # A single drain belongs to the wet pressure-vessel service area. It is
    # flush with the concrete, not a raised rail crossing working aisles.
    a.box((5.04,.008,-4.11),(2.05,.018,.46),10,.008)
    for i in range(17):a.box((4.09+i*.119,.020,-4.11),(.054,.012,.405),10,.003)
    # Heavy rolling freight gate, aligned with the clear tank approach lane.
    # Individual interlocking convex slats sit in captured roller channels.
    a.group='freight shutter and bulkhead'
    a.box((0,2.12,9.0),(7.12,4.24,.20),10,.015)
    profile=[(-.106,8.835),(-.095,8.785),(-.055,8.753),(0,8.742),(.055,8.753),(.095,8.785),(.106,8.835)]
    for row in range(19):
        cy=.115+row*.217
        for j in range(len(profile)-1):
            ya,za=profile[j];yb,zb=profile[j+1]
            a.face([(-3.45,cy+ya,za),(3.45,cy+ya,za),(3.45,cy+yb,zb),(-3.45,cy+yb,zb)],18,(0,0,-1))
        # Recessed knuckle seam and end rollers make the shutter construction readable.
        a.cylinder((-3.40,cy-.104,8.813),(3.40,cy-.104,8.813),.016,10,8)
        for side in (-1,1):
            a.cylinder((side*3.43,cy,8.82),(side*3.56,cy,8.82),.052,10,12)
            if row%3==0:a.bolt((side*3.30,cy,8.728),(0,0,-1),.024)
    for side in (-1,1):
        x=side*3.55
        a.box((x,2.16,8.96),(.34,4.32,.40),10,.025)
        a.box((x+side*.11,2.16,8.67),(.11,4.32,.23),18,.014)
        a.box((x-side*.087,2.16,8.663),(.072,4.32,.12),19,.008)
        for y in (.25,.80,1.35,1.9,2.45,3,3.55,4.12):
            a.bolt((x+side*.07,y,8.538),(0,0,-1),.043)
        a.box((x,.12,8.64),(.54,.24,.64),18,.03)
        a.box((x,4.45,8.82),(.38,.39,.60),10,.035)
        a.cylinder((x-.21,4.57,8.70),(x+.21,4.57,8.70),.16,19,24)
    a.box((0,4.32,8.86),(7.58,.25,.42),18,.025)
    # Exposed roll barrel and machined end rings; the tracks curve into it.
    a.cylinder((-3.44,4.63,8.87),(3.44,4.63,8.87),.285,10,40)
    for x in (-3.41,-2.3,-1.15,0,1.15,2.3,3.41):a.torus((x,4.63,8.87),.288,.022,19,(1,0,0),32,6)
    for side in (-1,1):
        a.pipe([(side*3.52,3.95,8.79),(side*3.52,4.32,8.79),(side*3.52,4.63,9.08)],.045,10,False)
    a.box((3.99,4.42,8.71),(.59,.63,.45),18,.047)
    a.cylinder((3.70,4.57,8.70),(3.94,4.57,8.70),.13,19,24)
    a.cylinder((4.05,4.35,8.48),(4.05,4.35,8.09),.20,10,24,.16)
    for y in (4.17,4.26,4.35,4.44,4.53):a.box((4.05,y,8.28),(.32,.019,.30),10,.004)
    # Wall operator, electrical conduit and a physically accessible manual override.
    a.pipe([(3.99,4.11,8.64),(3.99,1.44,8.64),(4.25,1.44,8.64)],.022,10,False)
    a.box((4.25,1.32,8.61),(.31,.43,.20),18,.025)
    for y in (1.20,1.34,1.47):a.cylinder((4.25,y,8.50),(4.25,y,8.46),.043,19 if y<1.4 else 5,12)
    a.wheel((3.95,1.98,8.40),.20,(0,0,1))
    a.cylinder((3.95,1.98,8.43),(3.95,1.98,8.76),.035,10,12)
    a.box((0,.007,8.53),(6.74,.014,.35),10,.003)
    # A protected horizontal work lamp lights the threshold and door hardware.
    a.box((0,4.99,8.58),(1.32,.18,.30),10,.025)
    a.box((0,4.885,8.55),(1.15,.025,.20),5,.007)


def overhead_crane(a):
    """A parked underhung bridge and two-fall pocket-chain hoist.

    Longitudinal wheels rotate about X and bear on the upper faces of the
    runway lower flanges. Transverse hoist wheels rotate about Z on the bridge
    flange. Carrier plates and stub axles clear the structural webs throughout
    travel; the lamps are outside the whole moving bridge envelope.
    """
    a.group='overhead gantry crane rails'
    for x in (-2.55,2.55):
        a.box((x,5.14,0),(.20,.35,13.8),10,.012)
        a.box((x,5.35,0),(.46,.075,13.8),10,.009)
        a.box((x,4.97,0),(.40,.07,13.8),10,.007)
        for z in (-6.2,6.7):
            a.cylinder((x,5.34,z),(x,5.92,z),.045,10,10)
            a.box((x,5.87,z),(.44,.08,.34),10,.012)
            for dx in (-.13,.13):a.bolt((x+dx,5.918,z),(0,1,0),.025)
        # Four independently bearing wheels per rail, two on each web side.
        for side in (-1,1):
            px=x+side*.260
            a.box((px,4.935,-2.9),(.045,.62,.92),18,.019)
            for z in (-3.20,-2.60):
                a.cylinder((x+side*.115,5.115,z),(x+side*.193,5.115,z),.110,10,24)
                # Inboard flange clears the web by 7mm; tread contacts y5.005.
                a.cylinder((x+side*.107,5.115,z),(x+side*.120,5.115,z),.123,10,24)
                a.cylinder((x+side*.149,5.115,z),(x+side*.293,5.115,z),.026,19,12)
                a.cylinder((x+side*.283,5.115,z),(x+side*.316,5.115,z),.059,19,16)
                a.bolt((x+side*.316,5.115,z),(side,0,0),.025)
                for y in (4.71,4.85):a.bolt((px+side*.026,y,z),(side,0,0),.026)
            a.box((px,4.647,-2.9),(.07,.075,.88),10,.009)
    # Genuine H bridge, with an unobstructed lower running flange.
    a.box((0,4.66,-2.9),(5.96,.33,.11),10,.010)
    a.box((0,4.86,-2.9),(5.96,.07,.45),10,.009)
    a.box((0,4.455,-2.9),(5.96,.07,.46),10,.009)
    for x in (-2.9,2.9):a.box((x,4.72,-2.9),(.065,.33,.49),18,.009)
    # Cross-travel trolley; its cheeks lie beyond the lower flange edges.
    for side in (-1,1):
        z=-2.9+side*.272
        a.box((.75,4.355,z),(.79,.59,.047),18,.018)
        for x in (.49,1.01):
            a.cylinder((x,4.595,-2.9+side*.10),(x,4.595,-2.9+side*.194),.105,10,24)
            a.cylinder((x,4.595,-2.9+side*.085),(x,4.595,-2.9+side*.10),.119,10,24)
            a.cylinder((x,4.595,-2.9+side*.14),(x,4.595,-2.9+side*.31),.025,19,12)
            a.bolt((x,4.595,-2.9+side*.303),(0,0,side),.037)
            a.bolt((x,4.16,z+side*.026),(0,0,side),.03)
    for x in (.49,1.01):a.cylinder((x,4.105,-3.21),(x,4.105,-2.59),.043,10,12)
    a.box((.75,3.985,-2.9),(.58,.36,.48),18,.045)
    # Pocket wheel, reduction casing and an axially connected electric motor.
    a.cylinder((.75,3.985,-3.12),(.75,3.985,-2.68),.19,10,24)
    a.cylinder((.75,3.985,-2.685),(.75,3.985,-2.60),.23,19,24)
    a.cylinder((.75,3.985,-3.47),(.75,3.985,-3.13),.145,10,20)
    for z in (-3.43,-3.36,-3.29,-3.22):a.cylinder((.75,3.985,z-.011),(.75,3.985,z+.011),.164,10,20)
    for i in range(6):
        t=i/6*TAU;a.bolt((.75+math.cos(t)*.176,3.985+math.sin(t)*.176,-2.59),(0,0,1),.021)
    a.box((1.19,3.75,-2.9),(.26,.42,.29),18,.05)
    a.beam((1.03,4.10,-2.9),(1.19,3.98,-2.9),.048,.045,10,.008)

    def link(center,tangent,index):
        center=V(center);tangent=V(tangent).normalized()
        side=V((0,0,1)) if index%2 else V((tangent.y,-tangent.x,0))
        normal=tangent.cross(side).normalized()
        rings=[];normals=[]
        for i in range(16):
            t=i/16*TAU
            path=center+tangent*(math.cos(t)*.049)+side*(math.sin(t)*.022)
            out=(tangent*(math.cos(t)/.049)+side*(math.sin(t)/.022)).normalized()
            ns=[out*math.cos(j/6*TAU)+normal*math.sin(j/6*TAU) for j in range(6)]
            rings.append([path+n*.010 for n in ns]);normals.append(ns)
        for i in range(16):
            k=(i+1)%16
            for j in range(6):
                q=(j+1)%6
                a.face([rings[i][j],rings[k][j],rings[k][q],rings[i][q]],10,
                       normals=[normals[i][j],normals[k][j],normals[k][q],normals[i][q]])

    a.group='hanging linked chains and crane hook'
    cx,cy,cz=.75,3.12,-2.9
    radius=.18;drop=3.865-cy;length=2*drop+math.pi*radius
    count=round(length/.082)
    for i in range(count+1):
        distance=length*i/count
        if distance<drop:p=(cx-radius,3.865-distance,cz);t=(0,-1,0)
        elif distance<drop+math.pi*radius:
            angle=math.pi+(distance-drop)/radius
            p=(cx+radius*math.cos(angle),cy+radius*math.sin(angle),cz)
            t=(-math.sin(angle),math.cos(angle),0)
        else:p=(cx+radius,cy+distance-drop-math.pi*radius,cz);t=(0,1,0)
        link(p,t,i)
    # Fixed chain end enters a pinned lug; the opposite fall enters the hoist.
    a.box((cx-radius,3.87,cz),(.095,.11,.13),10,.016)
    a.cylinder((cx-radius,3.856,cz-.10),(cx-radius,3.856,cz+.10),.021,19,10)
    a.cylinder((cx,cy,cz-.048),(cx,cy,cz+.048),.149,10,28)
    for side in (-1,1):
        a.cylinder((cx,cy,cz+side*.048),(cx,cy,cz+side*.067),.185,19,28)
        a.box((cx,cy-.045,cz+side*.098),(.29,.42,.036),18,.032)
        a.bolt((cx,cy,cz+side*.121),(0,0,side),.052)
        for dx in (-.085,.085):a.bolt((cx+dx,cy-.19,cz+side*.121),(0,0,side),.022)
    a.cylinder((cx,cy,cz-.147),(cx,cy,cz+.147),.034,10,12)
    # Thrust collar, swivel spindle, double-shear clevis and retained cross-pin.
    a.cylinder((cx,2.72,cz),(cx,2.955,cz),.044,10,16)
    a.cylinder((cx,2.845,cz),(cx,2.91,cz),.076,19,20)
    for side in (-1,1):a.box((cx,2.757,cz+side*.069),(.17,.17,.035),10,.027)
    a.torus((cx,2.715,cz),.047,.020,19,(0,0,1),20,8)
    a.cylinder((cx,2.715,cz-.114),(cx,2.715,cz+.114),.025,10,12)
    for side in (-1,1):a.bolt((cx,2.715,cz+side*.111),(0,0,side),.031)
    # Smooth tapered forging; no closed torus masquerading as a lifting hook.
    controls=[V(p) for p in ((cx,2.675,cz),(.739,2.585,cz),(.638,2.489,cz),
                            (.623,2.338,cz),(.753,2.266,cz),(.898,2.319,cz),(.948,2.457,cz))]
    points=[];radii=[]
    for segment in range(len(controls)-1):
        p0=controls[max(0,segment-1)];p1=controls[segment];p2=controls[segment+1];p3=controls[min(len(controls)-1,segment+2)]
        for step in range(6):
            t=step/6
            points.append((p1*2+(p2-p0)*t+(p0*2-p1*5+p2*4-p3)*t*t+(-p0+p1*3-p2*3+p3)*t*t*t)*.5)
            f=(segment+t)/(len(controls)-1);radii.append(.047+.013*math.sin(f*math.pi)-.031*f**4)
    points.append(controls[-1]);radii.append(.016)
    rings=[];ns=[]
    for i,p in enumerate(points):
        tangent=(points[min(i+1,len(points)-1)]-points[max(0,i-1)]).normalized()
        u=V((0,0,1));v=tangent.cross(u).normalized()
        normal=[u*math.cos(j/10*TAU)+v*math.sin(j/10*TAU) for j in range(10)]
        rings.append([p+n*radii[i] for n in normal]);ns.append(normal)
    for i in range(len(rings)-1):
        for j in range(10):
            k=(j+1)%10
            a.face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],18,normals=[ns[i][j],ns[i][k],ns[i+1][k],ns[i+1][j]])
    a.face(rings[0],18,(0,1,0));a.face(rings[-1],18,(0,1,0))
    # The spring gate bridges the open throat and pivots on the upper shank.
    a.cylinder((.770,2.583,cz-.051),(.770,2.583,cz+.051),.024,19,12)
    a.beam((.770,2.583,cz),(.940,2.469,cz),.018,.037,19,.004)
    a.torus((.770,2.583,cz+.043),.028,.006,10,(0,0,1),14,5)


def utilities(a):
    a.group='flanged copper distribution lines'
    for side in (-1,1):
        for j in range(2):
            x=side*(6.37-j*.28);y=3.58+j*.39
            a.pipe([(x,y,-8.1),(x,y,7.8)],.105 if j==0 else .07)
            for z in (-7,-4,-1,2,5,7.5):
                a.flange((x,y,z),(0,0,1),.105 if j==0 else .07)
                a.box((side*6.6,y,z),(.65,.045,.15),10,.009)
        a.pipe([(side*6.37,3.58,-3.2),(side*6.37,1.8,-3.2),(side*5.8,1.8,-3.2)],.095)
        a.wheel((side*5.72,1.8,-3.2),.24,(1,0,0))
    # Steam header following the vault with straight manufacturable sections.
    points=[]
    for i in range(9):
        t=-math.pi/2+i/8*math.pi
        points.append((6.12*math.sin(t),3.38+3.7*math.cos(t),-6.92))
    a.pipe(points,.115)
    overhead_crane(a)
    for x,z,end in ((-6.04,-6.2,2.5),(6.04,6.7,2.6)):
        y=4.38
        while y>end:
            a.torus((x,y,z),.068,.014,10,(0,0,1) if int(y*10)%2 else (1,0,0),10,4)
            y-=.1
    # Service luminaires are articulated runtime CAD assemblies in workshop/lamps.ts.


def boiler(a):
    a.group='pressure vessel and steam controls'
    x,z=5.06,-5.73
    a.box((x,.12,z),(2.12,.24,2.15),10,.06)
    for dx in (-.59,.59):
        for dz in (-.6,.6):a.box((x+dx,.43,z+dz),(.19,.62,.19),10,.025)
    a.cylinder((x,.49,z),(x,3.08,z),.81,12,32)
    a.cylinder((x,3.08,z),(x,3.4,z),.81,12,32,.25)
    a.cylinder((x,.4,z),(x,.56,z),.65,10,24,.81)
    for y in (.64,1.68,2.78,3.07):
        a.cylinder((x,y-.045,z),(x,y+.045,z),.839,11,32)
        for i in range(14):
            t=i/14*TAU;d=(math.cos(t),0,math.sin(t))
            a.bolt((x+d[0]*.849,y,z+d[2]*.849),d,.034)
    a.pipe([(x,3.4,z),(x,3.86,z),(6.1,3.86,z),(6.1,3.86,-6.92)],.16)
    a.pipe([(x-.55,1.1,z+.63),(x-.55,1.1,z+1.12),(x-1.22,1.1,z+1.12),(x-1.22,3.4,z+1.12)],.07)
    a.gauge((x-.35,2.34,z+.8),.28,reading=.68)
    a.gauge((x+.32,2.31,z+.8),.17,reading=.43)
    a.wheel((x+.2,1.66,z+.9),.3)
    a.cylinder((x-.54,.72,z+.54),(x-.54,2.05,z+.54),.042,11,10)
    a.box((x-.54,1.42,z+.59),(.14,1.31,.075),10,.018)
    a.box((x-.54,1.58,z+.638),(.065,.55,.013),5,.004)
    # Coal firebox: circular machined door with hinges and locking handle.
    a.cylinder((x,1.07,z+.70),(x,1.07,z+.87),.37,10,24)
    a.torus((x,1.07,z+.9),.325,.035,11,major=24)
    a.box((x,1.07,z+.924),(.45,.07,.06),11,.012)
    for dx in (-.31,.31):a.box((x+dx,1.07,z+.86),(.08,.2,.1),11,.012)
    # Receiver and cooling-fin machinery on the left creates asymmetric weight.
    a.group='compressor and flywheel machinery'
    x,z=-5.23,-6.3
    a.box((x,.18,z),(2.4,.36,1.65),10,.04)
    a.cylinder((x-.9,.85,z),(x+.9,.85,z),.49,12,24)
    for xx in (x-.91,x+.91):a.cylinder((xx-.035,.85,z),(xx+.035,.85,z),.55,11,24)
    a.box((x,1.28,z),(1.18,.52,.75),10,.055)
    for i in range(9):a.box((x-.49+i*.122,1.57,z),(.06,.45,.81),11,.006)
    a.cylinder((x,1.96,z),(x,2.3,z),.31,10,16)
    a.pipe([(x,2.3,z),(x,2.76,z),(-6.1,2.76,z),(-6.1,3.62,z)],.07)
    a.wheel((x+.9,1.45,z+.46),.63,material=10)
    a.torus((x+.9,1.45,z+.46),.48,.035,11,major=24)
    a.gauge((x-.54,1.93,z+.32),.18,reading=.76)


def furniture(a):
    a.group='machinist workbench and wall tool board'
    x,z=5.68,-.65
    a.box((x,1.04,z),(1.64,.16,3.7),10,.025)
    a.box((x,1.132,z),(1.7,.045,3.75),11,.008)
    for xx in (x-.65,x+.65):
        for zz in (z-1.57,z+1.57):a.box((xx,.52,zz),(.11,1.02,.11),10,.009)
    a.box((x,.28,z),(1.47,.09,3.42),10,.01)
    # Drawer cabinet and individually framed drawer fronts facing aisle.
    a.box((x-.04,.61,z+.77),(1.34,.67,1.27),10,.025)
    for j in range(3):
        a.box((x-.73,.37+j*.215,z+.77),(.055,.18,1.18),10,.012)
        a.beam((x-.78,.37+j*.215,z+.5),(x-.78,.37+j*.215,z+1.04),.028,.035,11)
    a.box((6.74,2.01,z),(.1,1.48,3.66),10,.025)
    for y in (1.31,2.73):a.box((6.655,y,z),(.08,.055,3.69),11,.01)
    for zz in (-2.5,1.2):a.box((6.655,2.01,zz),(.08,1.48,.065),11,.01)
    # Silhouetted spanners, hammers and calipers are geometry on the pegboard.
    for j in range(7):
        zz=-2.15+j*.43;y=2.22-(j%2)*.12
        a.beam((6.54,y-.33,zz),(6.54,y+.27,zz),.055,.06,11,.01)
        a.torus((6.54,y+.3,zz),.08,.018,11,(1,0,0),12,4)
        if j%2:
            a.box((6.54,y-.35,zz),(.085,.11,.23),10,.013)
        else:
            for dd in (-.072,.072):a.box((6.54,y-.37,zz+dd),(.065,.17,.028),11,.006)
    # Engineer's vice, threaded spindle and hand wheel.
    a.box((5.28,1.23,.64),(.41,.16,.42),10,.022)
    a.box((5.12,1.4,.64),(.16,.23,.4),11,.019)
    a.box((5.41,1.4,.64),(.14,.23,.4),11,.019)
    a.cylinder((4.92,1.34,.64),(5.53,1.34,.64),.048,10,10)
    a.cylinder((4.92,1.15,.64),(4.92,1.51,.64),.019,11,8)
    for i in range(5):a.cylinder((5.5,1.17,-1.3+i*.2),(5.5,1.3,-1.3+i*.2),.07+.009*i,11,12)
    a.gauge((5.49,1.25,-.7),.11,(0,1,0))
    # Left spare-component storage; clear of robot and transfer trolleys.
    a.group='spares shelving and crates'
    x,z=-5.72,-2.7
    for xx in (x-.58,x+.58):
        for zz in (z-1.65,z+1.65):a.box((xx,1.67,zz),(.09,3.3,.09),10,.008)
    for y in (.18,1.15,2.16,3.12):a.box((x,y,z),(1.32,.08,3.6),10,.014)
    for j in range(5):
        zz=z-1.3+j*.62
        a.cylinder((x-.35,1.32,zz),(x+.25,1.32,zz),.22,10,16)
        a.cylinder((x-.38,1.32,zz),(x-.31,1.32,zz),.25,11,16)
        a.cylinder((x+.22,1.32,zz),(x+.3,1.32,zz),.25,11,16)
    a.group='placeholder shelf crates'
    for j in range(3):
        zz=z-.95+j*.95
        a.box((x,2.47,zz),(.91,.55,.77),10,.035)
        for dz in (-.3,.3):a.box((x,2.76,zz+dz),(.92,.035,.06),11,.005)
        a.box((x+.467,2.47,zz),(.016,.14,.29),11,.005)
    # Larger packing chests and scattered-but-deliberate floor equipment.
    a.group='placeholder packing chests'
    for xx,zz,w in ((-5.8,5.6,.86),):
        a.box((xx,.4,zz),(w,.78,.86),10,.055)
        for dx in (-w*.35,w*.35):a.box((xx+dx,.4,zz+.438),(.05,.79,.025),11,.004)
        a.box((xx,.81,zz),(w+.04,.07,.91),11,.014)


def backwall(a,scene):
    a.group='great circular ventilation assembly'
    # One non-overlapping cast annular cowling. Separate front, bevel, barrel
    # and duct surfaces share boundary edges; no layered coplanar disks.
    for i in range(48):
        ta=i/48*TAU;tb=(i+1)/48*TAU
        def point(t,r,z):return (math.cos(t)*r,4.22+math.sin(t)*r,z)
        radial=(math.cos((ta+tb)*.5),math.sin((ta+tb)*.5),0)
        a.face([point(ta,1.515,-8.53),point(tb,1.515,-8.53),point(tb,1.765,-8.53),point(ta,1.765,-8.53)],11,(0,0,1))
        a.face([point(ta,1.765,-8.53),point(tb,1.765,-8.53),point(tb,1.81,-8.65),point(ta,1.81,-8.65)],11,radial)
        a.face([point(ta,1.48,-8.65),point(tb,1.48,-8.65),point(tb,1.515,-8.53),point(ta,1.515,-8.53)],11,(-radial[0],-radial[1],0))
        a.face([point(ta,1.81,-8.65),point(tb,1.81,-8.65),point(tb,1.81,-9.18),point(ta,1.81,-9.18)],10,radial)
    # A real open ventilation shaft, with a continuous tangent bend up toward
    # the surface. The elbow's distant wall is a curved surface, never a black
    # disk in the fan plane. Twelve metres of physical depth remain visible.
    shaft=[(V((0,4.22,z)),V((0,0,-1))) for z in (-8.65,-10,-11.5,-13,-14.5,-16.5)]
    for j in range(1,25):
        t=j/24*math.pi/2
        shaft.append((V((0,7.82-3.6*math.cos(t),-16.5-3.6*math.sin(t))),V((0,math.sin(t),-math.cos(t)))))
    shaft.append((V((0,11.0,-20.1)),V((0,1,0))))
    a.tint=(.48,.55,.59)
    rings=[];normals=[]
    for centre,tangent in shaft:
        u=V((1,0,0));v=u.cross(tangent).normalized()
        radial=[u*math.cos(i/48*TAU)+v*math.sin(i/48*TAU) for i in range(48)]
        rings.append([centre+p*1.48 for p in radial]);normals.append([-p for p in radial])
    for k in range(len(rings)-1):
        for i in range(48):
            j=(i+1)%48
            a.face([rings[k][i],rings[k+1][i],rings[k+1][j],rings[k][j]],10,normals[k][i],
                   [normals[k][i],normals[k+1][i],normals[k+1][j],normals[k][j]])
    a.tint=(1,1,1)
    # A separate front safety grille stands proud of the rim. Clear axial
    # separation from the rotating blade tips prevents cowling shimmer.
    a.torus((0,4.22,-8.34),1.47,.025,10,major=48,minor=6)
    for i in range(24):
        t=i/24*TAU
        a.bolt((math.cos(t)*1.66,4.22+math.sin(t)*1.66,-8.514),size=.043)
    # Runtime-owned fan blades/hub animate inside this authored safety guard.
    for x in (-1.0,-.5,0,.5,1.0):
        h=math.sqrt(1.45**2-x*x)
        a.beam((x,4.22-h,-8.34),(x,4.22+h,-8.34),.023,.023,10,.005)
    a.beam((-1.45,4.22,-8.33),(1.45,4.22,-8.33),.033,.028,10,.006)
    # Real tunnel depth is visible between blades. Sparse receding stiffeners
    # support a rear bearing motor and its shaft without sealing the aperture.
    a.tint=(.6,.65,.67)
    for z in (-9.7,-11.4,-13.2,-15.0,-16.5):a.torus((0,4.22,z),1.448,.025,10,major=48,minor=6)
    for j in (8,16,24):
        t=j/24*math.pi/2
        a.torus((0,7.82-3.6*math.cos(t),-16.5-3.6*math.sin(t)),1.448,.025,10,
                axis=(0,math.sin(t),-math.cos(t)),major=48,minor=6)
    for i in range(3):
        t=i/3*TAU+math.pi/2
        a.beam((math.cos(t)*.22,4.22+math.sin(t)*.22,-10.6),(math.cos(t)*1.46,4.22+math.sin(t)*1.46,-10.6),.06,.07,10,.008)
    a.cylinder((0,4.22,-11.13),(0,4.22,-10.20),.24,10,24)
    a.cylinder((0,4.22,-10.20),(0,4.22,-8.90),.072,10,16)
    a.tint=(1,1,1)
    for pos in ((.82,5.15,-12.9),(.82,5.68,-18.0)):
        a.box(pos,(.19,.10,.26),10,.025)
        a.box((pos[0],pos[1]-.056,pos[2]),(.13,.02,.18),5,.007)
    a.group='utilitarian bay numbers'
    a.text(scene,'03',(-2.9,1.25,-8.835),.85,9)
    a.text(scene,'03',(0,4.22,8.635),.26,19,rotation=(math.pi/2,0,math.pi))


def lived_in_details(a):
    a.group='selective service spills and mineral wear'
    # Thin irregular stains belong to the machinery they came from. Broad clean
    # aisles and the tank's hero silhouette remain deliberately uncluttered.
    for x,z,rx,rz in ((4.73,-4.25,.64,.38),(-4.84,-5.29,.51,.31),(5.01,.5,.38,.25)):
        count=18
        radii=[RNG.uniform(.75,1.15) for _ in range(count)]
        centre=V((x,.022,z))
        inner=[];outer=[]
        for i in range(count):
            theta=i/count*TAU
            delta=V((math.cos(theta)*rx*radii[i],0,math.sin(theta)*rz*radii[i]))
            inner.append(centre+delta*.72);outer.append(centre+delta)
        for i in range(count):
            j=(i+1)%count
            dark=(.028,.035,.028);edge=(.09,.105,.096)
            a.face([centre,inner[i],inner[j]],10,(0,1,0),colors=[dark,dark,dark])
            a.face([inner[i],outer[i],outer[j],inner[j]],9,(0,1,0),colors=[dark,edge,edge,dark])
    # Short drain-side drip trails, never a general dirt overlay.
    for i in range(12):
        x=4.6+RNG.random()*.7;z=-4.48-RNG.random()*.54
        a.cylinder((x,.023,z),(x,.026,z),RNG.uniform(.018,.035),10,8)
    a.group='parked inert ordnance trolley'
    x,z=-4.4,3.8
    a.box((x,.24,z),(1.08,.10,2.6),10,.025)
    for dx in (-.49,.49):a.box((x+dx,.35,z),(.07,.14,2.65),10,.012)
    for dx in (-.43,.43):
        for dz in (-1.03,1.03):
            a.cylinder((x+dx-.06,.16,z+dz),(x+dx+.06,.16,z+dz),.15,10,12)
            a.cylinder((x+dx-.064,.16,z+dz),(x+dx+.064,.16,z+dz),.055,11,10)
    for dz in (-.65,.65):
        a.box((x,.4,z+dz),(.72,.19,.19),10,.025)
        for dx in (-.35,.35):a.beam((x+dx,.42,z+dz),(x+dx*.7,.74,z+dz),.08,.07,11)
    a.tint=(.65,.88,.55)
    a.cylinder((x,.77,z-.8),(x,.77,z+.67),.36,10,24)
    a.cylinder((x,.77,z+.67),(x,.77,z+1.11),.36,10,24,.075)
    a.cylinder((x,.77,z-.98),(x,.77,z-.8),.17,10,20,.36)
    a.tint=(1,1,1)
    for dz in (-.56,.43):a.cylinder((x,.77,z+dz-.025),(x,.77,z+dz+.025),.367,11,24)
    for i in range(4):
        t=i/4*TAU
        a.box((x+math.cos(t)*.23,.77+math.sin(t)*.23,z-.86),(.42,.035,.37),10,.012,Matrix.Rotation(t,3,'Z'))
    a.box((x-.371,.81,z-.05),(.012,.17,.32),11,.006)
    # Handgrip stays behind the trolley, clear of the robot working envelope.
    for dx in (-.43,.43):a.beam((x+dx,.35,z-1.27),(x+dx,1.14,z-1.44),.035,.035,10)
    a.cylinder((x-.43,1.14,z-1.44),(x+.43,1.14,z-1.44),.03,11,8)
    a.group='brass cartridge rack'
    x,z=-3.25,-7.35
    a.box((x,.12,z),(1.22,.18,2.25),10,.025)
    for dx in (-.56,.56):
        for dz in (-1.05,1.05):a.box((x+dx,.71,z+dz),(.065,1.3,.065),10,.009)
    for y in (.44,1.04):
        for dx in (-.56,.56):a.box((x+dx,y,z),(.085,.07,2.15),10,.012)
        for dz in (-1.05,1.05):a.box((x,y,z+dz),(1.16,.07,.085),10,.012)
    for row in range(2):
        for j in range(4):
            xx=x-.27+row*.54;zz=z-.79+j*.53
            a.cylinder((xx,.21,zz),(xx,.91,zz),.155,11,16)
            a.cylinder((xx,.23,zz),(xx,.27,zz),.178,11,16)
            a.tint=(.65,.85,.55)
            a.cylinder((xx,.91,zz),(xx,1.18,zz),.147,10,16,.105)
            a.cylinder((xx,1.18,zz),(xx,1.43,zz),.105,10,16,.012)
            a.tint=(1,1,1)
            a.cylinder((xx,1.05,zz),(xx,1.09,zz),.135,12,16,.128)
    a.group='coiled service hose and hand tools'
    for i in range(3):a.torus((-4.97,.05+i*.029,-3.03),.36+i*.037,.022,10,(0,1,0),32,6)
    a.pipe([(-4.68,.045,-3.05),(-4.13,.045,-2.65),(-4.05,.045,-2.18)],.025,10,False)
    a.cylinder((-4.05,.047,-2.18),(-4.05,.047,-1.96),.045,11,10)
    screw_stool(a)
    a.group='coiled service hose and hand tools'
    # Lidded oil can beside the workbench.
    a.cylinder((6.03,.04,2.21),(6.03,.38,2.21),.14,12,16)
    a.cylinder((6.03,.38,2.21),(6.14,.54,2.27),.028,11,8,.017)


def screw_stool(a,x=4.58,z=1.22):
    """A fixed industrial tabouret: the seat and screw turn through a captive nut.

    The exposed trapezoidal thread is real connected geometry. Its root enters
    both the load-bearing nut and the under-seat boss; no separate floating
    spiral or coincident cylinder skins are used. Three welded splayed legs
    support the casting and a joined circular footrest.
    """
    a.group='screw-height machinist tabouret'
    def revolve(profile,material,sides=48,solid_color=None):
        for j in range(len(profile)-1):
            r0,y0=profile[j];r1,y1=profile[j+1]
            dr,dy=r1-r0,y1-y0
            length=math.hypot(dr,dy)
            if length<1e-7:continue
            for i in range(sides):
                t0=i/sides*TAU;t1=(i+1)/sides*TAU
                n0=V((dy*math.cos(t0)/length,-dr/length,dy*math.sin(t0)/length))
                n1=V((dy*math.cos(t1)/length,-dr/length,dy*math.sin(t1)/length))
                p00=(x+r0*math.cos(t0),y0,z+r0*math.sin(t0))
                p01=(x+r0*math.cos(t1),y0,z+r0*math.sin(t1))
                p10=(x+r1*math.cos(t0),y1,z+r1*math.sin(t0))
                p11=(x+r1*math.cos(t1),y1,z+r1*math.sin(t1))
                if r0<1e-7:pts=[p00,p11,p10];ns=[(n0+n1).normalized(),n1,n0]
                elif r1<1e-7:pts=[p00,p01,p10];ns=[n0,n1,(n0+n1).normalized()]
                else:pts=[p00,p01,p11,p10];ns=[n0,n1,n1,n0]
                a.face(pts,material,(n0+n1).normalized(),ns,colors=[solid_color]*len(pts) if solid_color else None)

    # Pressed/dished steel pan with a rolled edge, rather than a flat cylinder.
    revolve([(0,.792),(.075,.792),(.20,.802),(.278,.821),(.294,.832),
             (.298,.842),(.292,.851),(.281,.854),(.266,.844),(.218,.825),
             (.10,.811),(0,.809)],18,64)
    # The screw is retained in a substantial under-pan boss and bolted plate.
    revolve([(.024,.744),(.070,.744),(.084,.756),(.090,.779),(.071,.793),
             (.024,.793),(.024,.744)],18,32)
    for i in range(3):
        t=i/3*TAU+math.pi/6;u=V((math.cos(t),0,math.sin(t)))
        a.beam(V((x,.772,z))+u*.065,V((x,.800,z))+u*.205,.042,.026,18,.006)
        a.bolt(V((x,.781,z))+u*.073,(0,-1,0),.012,10)

    # Hollow load-bearing iron casting and its captive bronze threaded bush.
    revolve([(.026,.272),(.065,.272),(.087,.308),(.083,.375),(.066,.510),
             (.056,.554),(.027,.565),(.026,.272)],18,36)
    revolve([(.026,.538),(.043,.538),(.047,.555),(.047,.578),(.040,.586),
             (.026,.586),(.026,.538)],19,24)
    # Six-sided locknut sits directly on the bronze bush; a radial thumb lever
    # gives the mechanic a real way to lock the adjusted seating height.
    revolve([(.026,.586),(.051,.586),(.055,.592),(.055,.606),(.050,.614),
             (.026,.614),(.026,.586)],19,6)
    a.cylinder((x+.045,.600,z),(x+.117,.600,z),.012,10,12)
    a.cylinder((x+.117,.579,z),(x+.117,.622,z),.017,19,14)

    # A 48mm major-diameter, 16mm lead trapezoidal screw, mostly engaged inside
    # the central casting. Crest/flank/root are one helical surface; the root
    # lies .3mm inside the solid core, avoiding any coplanar overlap.
    steel=(.14,.155,.17)
    revolve([(0,.305),(.017,.305),(.017,.777),(0,.777)],10,40,steel)
    revolve([(.017,.731),(.046,.731),(.051,.739),(.051,.746),
             (.017,.746),(.017,.731)],10,32,steel)
    bottom,top,pitch=.340,.774,.016
    turns=(top-bottom)/pitch;steps=math.ceil(turns*28)
    profile=[(.0167,-.0045),(.024,-.0025),(.024,.0025),(.0167,.0045)]
    for i in range(steps):
        theta0=i/steps*turns*TAU;theta1=(i+1)/steps*turns*TAU
        for j in range(3):
            r0,y0=profile[j];r1,y1=profile[j+1]
            def point(t,r,y):return V((x+r*math.cos(t),bottom+t/TAU*pitch+y,z+r*math.sin(t)))
            def normal(t,r):
                tangent=V((-r*math.sin(t),pitch/TAU,r*math.cos(t)))
                across=V(((r1-r0)*math.cos(t),y1-y0,(r1-r0)*math.sin(t)))
                return across.cross(tangent).normalized()
            points=[point(theta0,r0,y0),point(theta1,r0,y0),point(theta1,r1,y1),point(theta0,r1,y1)]
            normals=[normal(theta0,r0),normal(theta1,r0),normal(theta1,r1),normal(theta0,r1)]
            a.face(points,10,sum(normals,V((0,0,0))).normalized(),normals,colors=[steel]*4)
    # Three splayed tubular legs, flat floor pads and reinforced footrest.
    for i in range(3):
        angle=i/3*TAU+math.pi/6;u=V((math.cos(angle),0,math.sin(angle)))
        path=[V((x,y,z))+u*r for r,y in ((.066,.492),(.115,.405),(.237,.28),(.340,.046))]
        a.pipe(path,.025,18,False)
        a.box(V((x,.018,z))+u*.34,(.128,.036,.088),18,.016,Matrix.Rotation(-angle,3,'Y'))
        a.cylinder(V((x,.035,z))+u*.34,V((x,.085,z))+u*.34,.028,10,16)
        # Welded spokes tie the rest to the central casting and each leg.
        a.beam(V((x,.298,z))+u*.075,V((x,.298,z))+u*.240,.027,.022,18,.005)
        a.bolt(V((x,.366,z))+u*.089,u,.014,10)
    a.torus((x,.290,z),.242,.018,18,(0,1,0),48,8)


def extract_pbr(path,layer):
    """Preserve the GLB's exact embedded 4K image bytes without resampling."""
    with open(path,'rb') as f:raw=f.read()
    json_length=struct.unpack_from('<I',raw,12)[0]
    doc=json.loads(raw[20:20+json_length])
    binary_start=20+json_length+8
    material=doc['materials'][0];pbr=material['pbrMetallicRoughness']
    mapping={'baseColor':pbr['baseColorTexture']['index'],'normal':material['normalTexture']['index'],'orm':pbr['metallicRoughnessTexture']['index']}
    result={}
    os.makedirs(OUT,exist_ok=True)
    os.makedirs(TEXTURE_SOURCE,exist_ok=True)
    for label,texture in mapping.items():
        image=doc['images'][doc['textures'][texture]['source']]
        view=doc['bufferViews'][image['bufferView']]
        extension='png' if image['mimeType']=='image/png' else 'jpg'
        filename=f'prop-{layer}-{label}.{extension}'
        start=binary_start+view.get('byteOffset',0)
        image_bytes=raw[start:start+view['byteLength']]
        # A geometry-only iteration must not recreate 200MB of already packaged
        # public originals or overwrite their independent shipping metadata.
        directories=(TEXTURE_SOURCE,) if os.path.isfile(os.path.join(OUT,f'prop-{layer}-{label}.webp')) else (OUT,TEXTURE_SOURCE)
        for directory in directories:
            with open(os.path.join(directory,filename),'wb') as f:f.write(image_bytes)
        result[label]=filename
    return result


def import_authored_prop(a,scene,path,centre,dimensions,yaw,centered=False,pivot=None,radial_radius=None):
    """Fit the complete original Meshy geometry, normals, UVs and 4K PBR maps.

    No decimation or remeshing is performed. Material 13 carries (u, 1-v, layer)
    in partLocal for the renderer's direct authored-texture path. Original GLBs
    remain untouched as source assets and preserve the exact generated result.
    """
    new_layer=path not in a.prop_layers
    if new_layer:
        a.prop_layers[path]=len(a.textures)
        a.textures.append(extract_pbr(path,len(a.textures)))
    layer=a.prop_layers[path]
    before=set(bpy.data.objects)
    before_images=set(bpy.data.images);before_materials=set(bpy.data.materials)
    bpy.ops.import_scene.gltf(filepath=path)
    imported=[o for o in bpy.data.objects if o not in before]
    meshes=[o for o in imported if o.type=='MESH']
    bpy.context.view_layer.update()
    bounds=[o.matrix_world@V(c) for o in meshes for c in o.bound_box]
    lo=V(tuple(min(p[i] for p in bounds) for i in range(3)))
    hi=V(tuple(max(p[i] for p in bounds) for i in range(3)))
    # Blender Z-up bounds mapped to source game X/Y/Z before optional yaw.
    extent=hi-lo
    scale=min(dimensions[0]/extent.x,dimensions[1]/extent.z,dimensions[2]/extent.y)
    origin=V(((lo.x+hi.x)*.5,(lo.y+hi.y)*.5,(lo.z+hi.z)*.5 if centered else lo.z))
    if pivot is not None:origin=V(blender(pivot))
    if radial_radius is not None:
        # A seven-blade rotor's rectangular bounds are smaller than its swept
        # circle. Fit the true tip radius around the measured shaft axis.
        radius=max(math.hypot((o.matrix_world@v.co-origin).x,(o.matrix_world@v.co-origin).z) for o in meshes for v in o.data.vertices)
        scale=min(scale,radial_radius/radius)
    tri_count=sum(sum(max(0,len(p.vertices)-2) for p in o.data.polygons) for o in meshes)
    yaw_mat=Matrix.Rotation(yaw,3,'Y')
    if new_layer:a.imported_materials.append(meshes[0].data.materials[0])
    exported=0
    top_points=[]
    for obj in meshes:
        evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        uv_layer=mesh.uv_layers.active
        normal_matrix=obj.matrix_world.to_3x3().inverted().transposed()
        for tri in mesh.loop_triangles:
            pts=[];norms=[];colors=[]
            for vi,li in zip(tri.vertices,tri.loops):
                raw=(obj.matrix_world@mesh.vertices[vi].co-origin)*scale
                p=yaw_mat@V((raw.x,raw.z,-raw.y))+V(centre)
                if 'pressure-boiler' in path and raw.z>extent.z*scale-.018:top_points.append(p)
                n=normal_matrix@mesh.corner_normals[li].vector
                n=(yaw_mat@V((n.x,n.z,-n.y))).normalized()
                uv=uv_layer.data[li].uv if uv_layer else (0,0)
                pts.append(p);norms.append(n);colors.append((uv.x,1-uv.y,float(layer)))
            a.face(pts,13,normals=norms,subdivide=False,colors=colors)
            exported+=1
        evaluated.to_mesh_clear()
    for obj in imported:
        data=obj.data;bpy.data.objects.remove(obj,do_unlink=True)
        if isinstance(data,bpy.types.Mesh) and data.users==0:bpy.data.meshes.remove(data)
    if not new_layer:
        # glTF creates new packed image/material datablocks for every instance.
        # Runtime and source use the first shared material; discard only the
        # unused duplicates from this import before saving the .blend.
        for mat in list(bpy.data.materials):
            if mat not in before_materials and mat.users==0:bpy.data.materials.remove(mat)
        for image in list(bpy.data.images):
            if image not in before_images and image.users==0:bpy.data.images.remove(image)
    actual_dimensions=(extent.x*scale,extent.z*scale,extent.y*scale)
    if top_points:
        vent=sum(top_points,V((0,0,0)))/len(top_points)
        a.steam_vent=[vent.x,extent.z*scale+.02,vent.z]
    print(json.dumps({'prop':os.path.basename(os.path.dirname(path)),'sourceTriangles':tri_count,'runtimeTriangles':exported,'scale':scale,'centre':centre,'dimensions':actual_dimensions,'layer':layer}))
    return actual_dimensions


def make_scene():
    old=bpy.data.scenes.get(SCENE_NAME)
    if old:
        for obj in list(old.objects):
            if obj.name.startswith(PREFIX):
                data=obj.data;bpy.data.objects.remove(obj,do_unlink=True)
                if data and data.users==0:
                    if isinstance(data,bpy.types.Mesh):bpy.data.meshes.remove(data)
                    elif isinstance(data,bpy.types.Camera):bpy.data.cameras.remove(data)
                    elif isinstance(data,bpy.types.Light):bpy.data.lights.remove(data)
        bpy.data.scenes.remove(old)
    scene=bpy.data.scenes.new(SCENE_NAME)
    if bpy.context.window:bpy.context.window.scene=scene
    return scene


def occluders():
    solids=[
        {'min':[-7.6,-.73,-9.4],'max':[-1.72,-.005,9.4]},
        {'min':[1.72,-.73,-9.4],'max':[7.6,-.005,9.4]},
        {'min':[-1.72,-.73,-9.4],'max':[1.72,-.005,-2.1]},
        {'min':[-1.72,-.73,2.1],'max':[1.72,-.005,9.4]},
        {'min':[-1.72,-.85,-2.1],'max':[1.72,-.725,2.1]},
        {'min':[-7.6,0,-9.3],'max':[-6.94,8.5,9.3]},
        {'min':[6.94,0,-9.3],'max':[7.6,8.5,9.3]},
        {'min':[-7.2,0,-9.35],'max':[7.2,8.5,-8.86],'fanAperture':True},
        {'min':[-7.2,0,8.91],'max':[7.2,8.5,9.35]},
        # Solid centres of equipment, intentionally avoiding open legs/piping.
        {'min':[4.8,.4,-6.0],'max':[5.30,2.6,-5.5]},
        {'min':[5.55,.24,-2.0],'max':[5.93,.7,-1.55]},
        {'min':[5.55,.24,-.95],'max':[5.93,.7,-.36]},
        {'min':[5.55,.24,.54],'max':[5.93,.7,.95]},
        {'min':[-5.6,.35,-6.5],'max':[-4.95,.7,-6.16]},
    ]
    # The rack is open, so only its four actual steel shelf plates occlude.
    # A single enclosing box would incorrectly blacken all authored crates.
    for y in (.18,1.15,2.16,3.12):
        solids.append({'min':[-6.36,y-.025,-4.45],'max':[-5.09,y+.025,-.95]})
    for i in range(12):
        x=-7+i*14/12;end=x+14/12
        inner=min(abs(x),abs(end))
        y=3.3+4.2*math.sqrt(max(0,1-(inner/7)**2))
        solids.append({'min':[x,y+.025,-9.2],'max':[end,8.5,9.2]})
    if os.path.isfile(os.path.join(SOURCE,'meshy','rolling-tool-cabinet','model.glb')):
        for x,z in ((-3.0,-3.6),(-4.55,1.2)):
            solids.append({'min':[x-.50,.23,z-.35],'max':[x+.5,.43,z+.35]})
    return solids


def export(a,scene):
    os.makedirs(OUT,exist_ok=True)
    all_batches=[(False,m,b) for m,b in sorted(a.batches.items())]+[(True,m,b) for m,b in sorted(a.fan_batches.items())]
    triangle_count=sum(len(b['i'])//3 for _,_,b in all_batches)
    if triangle_count>600000:raise RuntimeError(f'triangle budget exceeded: {triangle_count}')
    manifest={'version':1,'name':'Underground Service Bay 03','source':'Blender 5.2 CAD architecture; image-generated atlas; complete Meshy geometry with original 4K PBR textures','bounds':{'min':[-7.5,-.85,-21.6],'max':[7.5,11,9.3]},'meshes':[],'fanRotor':[],'textures':a.textures,'occluders':occluders(),'steamVent':a.steam_vent}
    previous_path=os.path.join(OUT,'manifest.json')
    if os.path.isfile(previous_path):
        with open(previous_path,encoding='utf8') as f:previous=json.load(f)
        layers=previous.get('textures',[])
        same_sources=len(layers)==len(a.textures) and all(
            all(os.path.splitext(old[key])[0]==os.path.splitext(new[key])[0] and
                os.path.isfile(os.path.join(OUT,old[key])) for key in ('baseColor','normal','orm'))
            for old,new in zip(layers,a.textures))
        if same_sources and previous.get('textureEncoding'):
            for key in ('textures','textureEncoding','gaugeFace','source'):
                if key in previous:manifest[key]=previous[key]
    manifest['pressureGauge']={'center':[5.052,2.269,-4.864],'normal':[.02997558,.02697802,.999186],'radius':.238}
    for dynamic,material,batch in all_batches:
        n=len(batch['a']);indices=len(batch['i'])
        filename=f'{"fan" if dynamic else "room"}-{material}.bin'
        with open(os.path.join(OUT,filename),'wb') as f:
            for key in ('p','n','c'):array.array('f',batch[key]).tofile(f)
            for key in ('a','i'):array.array('I',batch[key]).tofile(f)
        tint=[1,.75,.38] if material==5 else [1,1,1]
        manifest['fanRotor' if dynamic else 'meshes'].append({'file':filename,'material':material,'tint':tint,'vertexCount':n,'indexCount':indices})
        # Blender mesh keeps the actual exported topology, color and normals.
        mesh=bpy.data.meshes.new(PREFIX+f'material_{material}')
        offset=V((0,4.22,-8.62)) if dynamic else V((0,0,0))
        pts=[blender(V(batch['p'][i:i+3])+offset) for i in range(0,len(batch['p']),3)]
        faces=[batch['i'][i:i+3] for i in range(0,indices,3)]
        mesh.from_pydata(pts,[],faces);mesh.update()
        for polygon in mesh.polygons:polygon.use_smooth=True
        mesh.normals_split_custom_set_from_vertices([blender(batch['n'][i:i+3]) for i in range(0,len(batch['n']),3)])
        if material==13:
            uv_layer=mesh.uv_layers.new(name='OriginalMeshyUV')
            for i,polygon in enumerate(mesh.polygons):
                vertex=polygon.vertices[0]
                polygon.material_index=int(batch['c'][vertex*3+2])
                for li in polygon.loop_indices:
                    vi=mesh.loops[li].vertex_index
                    uv_layer.data[li].uv=(batch['c'][vi*3],1-batch['c'][vi*3+1])
            for mat in a.imported_materials:mesh.materials.append(mat)
            obj=bpy.data.objects.new(PREFIX+('ROTATING_FAN_PBR' if dynamic else 'FULL_MESHY_PBR'),mesh);scene.collection.objects.link(obj)
            obj['runtime_material']=13;obj['geometry_preserved']=True
            continue
        attr=mesh.color_attributes.new(name='AuthoredAlbedo',type='FLOAT_COLOR',domain='POINT')
        rgba=[]
        for i in range(n):rgba.extend((*batch['c'][i*3:i*3+3],1))
        attr.data.foreach_set('color',rgba)
        mat=bpy.data.materials.get(PREFIX+f'mat_{material}') or bpy.data.materials.new(PREFIX+f'mat_{material}')
        mat.use_nodes=True
        nodes=mat.node_tree.nodes;shader=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
        color=next((n for n in nodes if n.type=='VERTEX_COLOR'),None) or nodes.new('ShaderNodeVertexColor')
        color.layer_name='AuthoredAlbedo'
        mat.node_tree.links.new(color.outputs['Color'],shader.inputs['Base Color'])
        shader.inputs['Metallic'].default_value=0 if material in (9,15,16,17) else .78
        shader.inputs['Roughness'].default_value={9:.92,10:.55,11:.34,12:.48,15:.96,16:.97,17:.98,18:.72,19:.58}.get(material,.3)
        architectural={15:('architecture-brick.png',2.5),16:('architecture-concrete.png',2/3),17:('architecture-vault.png',5/3),18:('fixture-paint.png',5/3),19:('fixture-brass.png',5/3)}
        if material in architectural:
            filename,repeat=architectural[material]
            image_path=os.path.join(TEXTURE_SOURCE,filename)
            if not os.path.isfile(image_path) and os.path.isfile(os.path.join(OUT,filename)):
                os.makedirs(TEXTURE_SOURCE,exist_ok=True)
                shutil.copyfile(os.path.join(OUT,filename),image_path)
            if os.path.isfile(image_path):
                texture=nodes.new('ShaderNodeTexImage');texture.image=bpy.data.images.load(image_path,check_existing=True)
                texture.image.filepath='//texture-source/'+filename
                texture.projection='BOX';texture.projection_blend=.18;texture.extension='REPEAT'
                position=nodes.new('ShaderNodeNewGeometry');scale=nodes.new('ShaderNodeVectorMath');scale.operation='SCALE';scale.inputs[3].default_value=repeat
                mat.node_tree.links.new(position.outputs['Position'],scale.inputs[0]);mat.node_tree.links.new(scale.outputs[0],texture.inputs['Vector'])
                multiply=nodes.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY';multiply.inputs[0].default_value=1
                if material in (18,19):multiply.inputs[1].default_value=(1,1,1,1)
                else:mat.node_tree.links.new(color.outputs['Color'],multiply.inputs[1])
                mat.node_tree.links.new(texture.outputs['Color'],multiply.inputs[2]);mat.node_tree.links.new(multiply.outputs[0],shader.inputs['Base Color'])
                bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.48;bump.inputs['Distance'].default_value=.012 if material==16 else .007
                mat.node_tree.links.new(texture.outputs['Color'],bump.inputs['Height']);mat.node_tree.links.new(bump.outputs['Normal'],shader.inputs['Normal'])
        if material==5:
            shader.inputs['Emission Color'].default_value=(1,.63,.27,1)
            shader.inputs['Emission Strength'].default_value=5
        mesh.materials.append(mat)
        obj=bpy.data.objects.new(PREFIX+f'ROOM_{material}',mesh);scene.collection.objects.link(obj)
        obj['runtime_material']=material;obj['atlas']='materials-atlas.png'
    manifest['triangles']=triangle_count
    manifest['features']=dict(a.names)
    with open(os.path.join(OUT,'manifest.json'),'w',encoding='utf8') as f:json.dump(manifest,f,indent=2)
    print(json.dumps({'triangles':manifest['triangles'],'vertices':sum(m['vertexCount'] for m in manifest['meshes']+manifest['fanRotor']),'features':manifest['features'],'export':OUT},indent=2))
    return manifest


def lighting(scene):
    world=bpy.data.worlds.get(PREFIX+'World') or bpy.data.worlds.new(PREFIX+'World')
    world.use_nodes=True
    bg=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND')
    bg.inputs['Color'].default_value=(.1,.13,.19,1);bg.inputs['Strength'].default_value=.12
    scene.world=world
    def light(name,pos,color,energy,size,target):
        data=bpy.data.lights.new(PREFIX+name,'AREA');data.energy=energy;data.color=color;data.shape='DISK';data.size=size
        obj=bpy.data.objects.new(PREFIX+name,data);scene.collection.objects.link(obj);obj.location=blender(pos)
        obj.rotation_euler=(V(blender(target))-obj.location).to_track_quat('-Z','Y').to_euler()
    for x in (-3.65,3.65):
        for z in (-1.5,1.5):light('Service', (x,4.52,z),(1,.84,.63),450,1.1,(0,.8,0))
    for x in (-5.9,5.9):
        for z in (-6,-1,4.5):light('Wall',(x,3.16,z),(1,.56,.22),210,1.1,(0,1,z))
    light('Vent rim',(0,6.4,-7.6),(.35,.61,1),600,3,(0,1.5,0))
    light('Shaft entry',(0,5.12,-10),(.50,.64,.75),55,.3,(0,4.22,-13))
    light('Shaft service A',(.82,5.15,-12.9),(.55,.68,.75),12,.16,(0,3.9,-13.3))
    light('Shaft service B',(.82,5.68,-18.0),(.55,.68,.75),12,.16,(0,5,-18.5))
    light('Lathe task',(4.95,3.05,.65),(1,.78,.48),50,.3,(5.65,1.45,-.65))
    light('Boiler task',(4.80,3.72,-4.62),(1,.8,.55),70,.3,(5.06,1.7,-5.73))
    light('Entrance',(0,4.0,7.8),(.7,.83,1),580,4,(0,1,0))
    cam_data=bpy.data.cameras.new(PREFIX+'ReviewCamera');cam_data.lens=24;cam_data.clip_start=.05
    cam=bpy.data.objects.new(PREFIX+'ReviewCamera',cam_data);scene.collection.objects.link(cam)
    cam.location=blender((4.5,3.7,6.2));target=V(blender((0,2.2,-2.3)))
    cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();scene.camera=cam
    try:scene.render.engine='CYCLES'
    except TypeError:pass
    if hasattr(scene,'cycles'):scene.cycles.samples=24
    scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'


def externalize_source_textures(a):
    """The review .blend shares exact public texture files, never packed copies."""
    def image_upstream(socket):
        todo=[link.from_node for link in socket.links];seen=set()
        while todo:
            node=todo.pop()
            if node in seen:continue
            seen.add(node)
            if node.type=='TEX_IMAGE' and node.image:return node.image
            for inp in node.inputs:todo.extend(link.from_node for link in inp.links)
        return None
    for layer,mat in enumerate(a.imported_materials):
        shader=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
        for key,socket in (('baseColor','Base Color'),('normal','Normal'),('orm','Roughness')):
            image=image_upstream(shader.inputs[socket])
            if image is None:raise RuntimeError(f'Missing {key} texture for layer {layer}')
            if image.packed_file:image.unpack(method='REMOVE')
            image.filepath='//texture-source/'+a.textures[layer][key]
    if a.atlas.packed_file:a.atlas.unpack(method='REMOVE')
    a.atlas.filepath='//materials-atlas.png'


def main():
    scene=make_scene();a=Author()
    boiler_path=os.path.join(SOURCE,'meshy','pressure-boiler','model.glb')
    lathe_path=os.path.join(SOURCE,'meshy','machinist-lathe','model.glb')
    cabinet_path=os.path.join(SOURCE,'meshy','rolling-tool-cabinet','model.glb')
    ordnance_path=os.path.join(SOURCE,'meshy','inert-ordnance-cart','model.glb')
    fan_path=os.path.join(SOURCE,'meshy','axial-fan-rotor','model.glb')
    compressor_path=os.path.join(SOURCE,'meshy','twin-cylinder-compressor','model.glb')
    crate_path=os.path.join(SOURCE,'meshy','reinforced-parts-crate','model.glb')
    if os.path.isfile(boiler_path):a.disabled.add('pressure vessel and steam controls')
    if os.path.isfile(lathe_path):a.disabled.add('machinist workbench and wall tool board')
    if os.path.isfile(ordnance_path):a.disabled.add('parked inert ordnance trolley')
    if os.path.isfile(compressor_path):a.disabled.add('compressor and flywheel machinery')
    if os.path.isfile(crate_path):a.disabled.update(('placeholder shelf crates','placeholder packing chests'))
    architecture(a);utilities(a);boiler(a);furniture(a);backwall(a,scene);lived_in_details(a)
    if os.path.isfile(boiler_path):
        a.group='Meshy 7.1 authored pressure boiler'
        import_authored_prop(a,scene,boiler_path,(5.06,0,-5.73),(2.25,3.8,2.25),0)
    if os.path.isfile(lathe_path):
        a.group='Meshy 7.1 authored machinist lathe'
        import_authored_prop(a,scene,lathe_path,(5.7,0,-.65),(3.7,2.45,1.6),-math.pi/2)
    if os.path.isfile(cabinet_path):
        for x,z in ((-3.0,-3.6),(-4.55,1.2)):
            a.group='Meshy 7.1 authored rolling cabinets'
            width,height,depth=import_authored_prop(a,scene,cabinet_path,(x,0,z),(1.62,.75,2),0)
            # Original cabinet proportions are preserved. A bolted adapter
            # frame reaches the functional moving payload deck's y=.75 datum.
            a.group='bolted cabinet payload adapter frames'
            for dx in (-width*.40,width*.40):
                for dz in (-depth*.36,depth*.36):
                    a.box((x+dx,(height+.71)*.5,z+dz),(.10,.71-height,.10),10,.01)
                    a.box((x+dx,height+.014,z+dz),(.21,.028,.20),10,.008)
                    for xx in (-.073,.073):a.bolt((x+dx+xx,height+.026,z+dz),(0,1,0),.019)
            for dx in (-width*.40,width*.40):
                a.box((x+dx,.73,z),(.105,.04,1.96),10,.008)
            for dz in (-.91,.91):a.box((x,.73,z+dz),(width*.8,.04,.08),10,.008)
    if os.path.isfile(ordnance_path):
        a.group='Meshy 7.1 authored inert ordnance trolley'
        # This asset's long axis is X and its nose points toward -X. Rotate
        # the preserved source by +90 degrees to park it nose-forward (+Z).
        import_authored_prop(a,scene,ordnance_path,(-4.4,0,5.0),(2.8,1.25,1.15),math.pi/2)
    if os.path.isfile(fan_path):
        a.group='Meshy 7.1 authored rotating seven-blade fan'
        static_batches=a.batches
        a.batches=defaultdict(lambda: {'p': [], 'n': [], 'c': [], 'a': [], 'i': []})
        # Original axial hub circle gives shaft center x=0,y=-.01246. Keep
        # 4cm radial clearance to the duct and over 5cm to the safety grille.
        import_authored_prop(a,scene,fan_path,(0,0,-.065),(3,3,.70),0,centered=True,pivot=(0,-.01246,.0022225),radial_radius=1.44)
        a.fan_batches=a.batches;a.batches=static_batches
    if os.path.isfile(compressor_path):
        a.group='Meshy 7.1 authored twin cylinder compressor'
        import_authored_prop(a,scene,compressor_path,(-5.23,0,-6.3),(2.18,2.4,1.6),0)
    if os.path.isfile(crate_path):
        a.group='Meshy 7.1 authored reinforced oak parts crates'
        for z in (-3.65,-2.7,-1.75):
            import_authored_prop(a,scene,crate_path,(-5.72,2.20,z),(.90,.65,.88),math.pi/2)
        import_authored_prop(a,scene,crate_path,(-5.8,0,5.6),(.86,.78,.86),math.pi/2)
    manifest=export(a,scene);lighting(scene);externalize_source_textures(a)
    clear_saved_browser_paths()
    # Save a separate .blend without changing the user's current file identity.
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SOURCE,'workshop.blend'),copy=True,compress=True,relative_remap=False)
    print('SERVICE BAY COMPLETE:',manifest['triangles'],'triangles')


if __name__=='__main__':main()
