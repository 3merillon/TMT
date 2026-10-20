"""Extract and retopologize the workshop bomb without its transport equipment.

Run in a separate Blender process (the live workshop scene is never touched):
  blender --background --factory-startup --python-exit-code 1 --python scripts/blender/extract-workshop-bomb.py

The joined source has no named bomb/carrier submeshes. Cast radial rays into its
original triangles to resample the casing and its original UV albedo. Bridge the
two transport-strap intervals and support-contact holes from adjacent bomb skin.
Retain the four fin surfaces from the original mesh. No workshop texture or room
is needed at runtime; compact quantized geometry and baked color ship as one
small binary asset, loaded with the renderer.
"""
import array, hashlib, json, math, os, struct
from pathlib import Path
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/workshop/meshy/inert-ordnance-cart/model.glb'
OUTPUT = ROOT / 'public/game/workshop-bomb.pmb'
REPORT = ROOT / 'assets/projectiles/workshop-bomb.provenance.json'
ART = ROOT / 'artifacts/projectile-effects/assets'
ART.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))
source = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
mesh = source.data
mesh.calc_loop_triangles()
# The GLTF importer changes source Y-up to Blender Z-up. Work in original GLTF space.
vertices = [Vector((v.co.x, v.co.z, -v.co.y)) for v in mesh.vertices]
triangles = list(mesh.loop_triangles)
bvh = BVHTree.FromPolygons(vertices, [t.vertices for t in triangles], all_triangles=True)
uv = mesh.uv_layers.active.data
material = source.data.materials[0]
bsdf = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
image = bsdf.inputs['Base Color'].links[0].from_node.image
width, height = image.size
pixels = array.array('f', [0.]) * (width * height * 4)
image.pixels.foreach_get(pixels)

def color_at(hit, face):
    t = triangles[face]
    a,b,c = (vertices[i] for i in t.vertices)
    v0,v1,v2=b-a,c-a,hit-a
    d00,d01,d11,d20,d21=v0.dot(v0),v0.dot(v1),v1.dot(v1),v2.dot(v0),v2.dot(v1)
    denom=d00*d11-d01*d01
    if abs(denom)<1e-15:weights=(1,0,0)
    else:
        v=(d11*d20-d01*d21)/denom;w=(d00*d21-d01*d20)/denom;weights=(1-v-w,v,w)
    coords=sum((uv[loop].uv * w for loop,w in zip(t.loops,weights)),Vector((0,0)))
    x=max(0,min(width-1,round(coords.x*(width-1))));y=max(0,min(height-1,round(coords.y*(height-1))))
    return tuple(pixels[(y*width+x)*4+j] for j in range(3))

CENTER=.180
STRAPS=((-0.637,-0.405),(.085,.321))
# Dimensions taken from clean upper-meridian intersections of the original casing.
PROFILE=[(-.946,.006),(-.932,.059),(-.910,.091),(-.865,.123),(-.8,.145),(-.72,.152),(-.60,.155),(-.30,.155),(.08,.150),(.25,.136),(.36,.118),(.50,.093),(.64,.067),(.76,.046),(.83,.035),(.862,.004)]
def expected(x):
    for (a,ra),(b,rb) in zip(PROFILE,PROFILE[1:]):
        if a<=x<=b:return ra+(rb-ra)*(x-a)/(b-a)
    return .004

def raw_sample(x,theta):
    direction=Vector((0,math.cos(theta),math.sin(theta)))
    hit,normal,face,distance=bvh.ray_cast(Vector((x,CENTER,0)),direction,.4)
    return (distance,color_at(hit,face)) if hit is not None else (expected(x),(.25,.265,.18))

bridged=0
def sample(x,theta):
    global bridged
    for left,right in STRAPS:
        if left < x < right:
            a,ca=sample(left-.004,theta);b,cb=sample(right+.004,theta)
            k=(x-left)/(right-left);bridged+=1
            return a*(1-k)+b*k,tuple(ca[i]*(1-k)+cb[i]*k for i in range(3))
    r,color=raw_sample(x,theta)
    reference=expected(x)
    # Carrier contact can swallow the lower skin in the joined source. Patch only
    # those contacts; sample an adjacent exposed azimuth to avoid cradle colors.
    if abs(r-reference)>max(.012,reference*.12):
        r=reference; _,color=raw_sample(x,theta*.2);bridged+=1
    return r,color

positions=[]; colors=[]; indices=[]
# Dense enough to retain the painted radiation insignia without any texture atlas.
RINGS=112; SEGMENTS=64
xs=[PROFILE[0][0]+(PROFILE[-1][0]-PROFILE[0][0])*i/RINGS for i in range(RINGS+1)]
for x in xs:
    for j in range(SEGMENTS):
        theta=math.tau*j/SEGMENTS;measured,color=sample(x,theta)
        # Profile retopology removes bumps belonging to contact-fused supports.
        r=expected(x)
        positions.append(Vector((x,CENTER+r*math.cos(theta),r*math.sin(theta))))
        colors.append(color)
for i in range(RINGS):
    for j in range(SEGMENTS):
        a=i*SEGMENTS+j;b=i*SEGMENTS+(j+1)%SEGMENTS;c=a+SEGMENTS;d=b+SEGMENTS
        indices.extend((a,b,c,b,d,c))
# Original fins (their outer faces are clear of the trolley handle and supports).
fin_triangles=0
for face,t in enumerate(triangles):
    ps=[vertices[v] for v in t.vertices];centroid=sum(ps,Vector())/3
    r=math.hypot(centroid.y-CENTER,centroid.z)
    normal=(ps[1]-ps[0]).cross(ps[2]-ps[0]).normalized()
    radial_dot=abs(normal.y*(centroid.y-CENTER)+normal.z*centroid.z)/max(r,.0001)
    fin_plane = radial_dot < .68
    if .53<centroid.x<.807 and .055<centroid.y<.334 and abs(centroid.z)<.172 and r>expected(centroid.x)+.011 and fin_plane:
        base=len(positions)
        positions.extend(ps)
        colors.extend(color_at(p,face) for p in ps)
        indices.extend((base,base+1,base+2));fin_triangles+=1
# Weld fin geometry while preserving vertex-color seams, then simplify only fins.
# Casing sampling intentionally replaces carrier contact patches with closed skin.
normals=[Vector() for _ in positions]
for a,b,c in zip(indices[0::3],indices[1::3],indices[2::3]):
    normal=(positions[b]-positions[a]).cross(positions[c]-positions[a])
    for i in (a,b,c):normals[i]+=normal
for i,n in enumerate(normals):
    if n.length_squared<1e-14:n=Vector((1 if positions[i].x>0 else -1,0,0))
    normals[i]=n.normalized()
# Source +X points toward the tail. Game +Z points toward the nose. 0.56 yields
# a one-unit miniature bomb; gameplay body diameter is 0.174, not a giant bomb.
def local(p):return Vector((p.z*.56,(p.y-CENTER)*.56,-(p.x+.042)*.56))
def local_normal(n):return Vector((n.z,n.y,-n.x))
positions=[local(p) for p in positions]
normals=[local_normal(n) for n in normals]
# PMB2: 24-byte header (counts and casing-grid dimensions), 6*i16 position/normal
# + 3*u8 encoded albedo per vertex, then only original fin u16 indices. The decoder
# reconstructs the regular casing indices exactly, with no geometry/color change.
# Coordinates quantize at 1/32767 game unit; colors are sRGB.
fin_indices=indices[RINGS*SEGMENTS*6:]
blob=bytearray(struct.pack('<4sIIIII',b'PMB2',len(positions),len(indices),RINGS,SEGMENTS,len(fin_indices)))
for p,n,color in zip(positions,normals,colors):
    blob.extend(struct.pack('<6h3B',*[round(max(-1,min(1,v))*32767) for v in (*p,*n)],*[round(max(0,min(1,v))*255) for v in color]))
blob.extend(struct.pack('<%dH'%len(fin_indices),*fin_indices))
OUTPUT.parent.mkdir(parents=True,exist_ok=True)
OUTPUT.write_bytes(bytes(blob))
REPORT.parent.mkdir(parents=True,exist_ok=True)
REPORT.write_text(json.dumps({'source':str(SOURCE.relative_to(ROOT)).replace('\\','/'),'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'sourceBytes':SOURCE.stat().st_size,'sourceTriangles':len(triangles),'method':'Radial surface/UV retopology from source triangles; bridge transport straps and cradle contacts; retain original fin faces','excluded':['trolley','wheels','cradles','transport straps','handle'],'strapIntervalsSourceX':STRAPS,'skinSamples':(RINGS+1)*SEGMENTS,'bridgedSamples':bridged,'originalFinTriangles':fin_triangles,'vertices':len(positions),'triangles':len(indices)//3,'encoding':'PMB2','casingGrid':{'rings':RINGS,'segments':SEGMENTS},'packedBytes':len(blob),'bounds':[[min(p[i] for p in positions) for i in range(3)],[max(p[i] for p in positions) for i in range(3)]]},indent=2)+'\n')
print(REPORT.read_text())
# Render the actual exported data (baked colors, same scale) for authoring QA.
bpy.data.objects.remove(source,do_unlink=True)
m=bpy.data.meshes.new('Extracted workshop bomb');m.from_pydata([tuple(p) for p in positions],[],list(zip(indices[0::3],indices[1::3],indices[2::3])));m.update()
o=bpy.data.objects.new(m.name,m);bpy.context.scene.collection.objects.link(o)
attr=m.color_attributes.new(name='Albedo',type='BYTE_COLOR',domain='POINT')
for i,c in enumerate(colors):attr.data[i].color_srgb=(*c,1)
mat=bpy.data.materials.new('Original olive enamel');mat.use_nodes=True
nodes=mat.node_tree.nodes;bsdf=nodes.get('Principled BSDF');col=nodes.new('ShaderNodeVertexColor');col.layer_name='Albedo';mat.node_tree.links.new(col.outputs['Color'],bsdf.inputs['Base Color']);bsdf.inputs['Roughness'].default_value=.48;bsdf.inputs['Metallic'].default_value=.65;m.materials.append(mat)
for p in m.polygons:p.use_smooth=True
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=24;s.render.resolution_x=1400;s.render.resolution_y=650;s.render.resolution_percentage=100
s.world=bpy.data.worlds.new('World');s.world.use_nodes=True;s.world.node_tree.nodes['Background'].inputs[0].default_value=(.16,.18,.20,1);s.world.node_tree.nodes['Background'].inputs[1].default_value=.6
for name,loc,power,size in [('Key',(2,3,3),220,3),('Fill',(-1,2,-2),120,2)]:
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;l=bpy.data.objects.new(name,d);s.collection.objects.link(l);l.location=loc;l.rotation_euler=(-l.location).to_track_quat('-Z','Y').to_euler()
d=bpy.data.cameras.new('Camera');cam=bpy.data.objects.new('Camera',d);s.collection.objects.link(cam);s.camera=cam;cam.location=(2,.55,.03);cam.rotation_euler=(-cam.location).to_track_quat('-Z','Y').to_euler();d.type='ORTHO';d.ortho_scale=1.18
# Camera right direction +localZ so the bomb nose remains on screen left.
cam.rotation_euler.rotate_axis('Z',-math.pi*.5)
s.render.filepath=str(ART/'extracted-bomb.png');bpy.ops.render.render(write_still=True)
