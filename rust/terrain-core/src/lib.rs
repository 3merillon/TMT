mod core;
mod storage;
mod packet;
mod wire;
mod world;
mod feed;
mod query;
mod body;
mod collider;
mod publication;
mod audit;
mod physics;
mod structural_liquid;
mod vehicle;
mod traversal;
mod match_state;
mod flight;
mod projectile_water;
mod combat;
mod ai;
mod ai_profile;
mod canonical;
mod bot_trace;
mod tick;
mod tread;
mod rig;

/// Each worker owns an independent handle and resident allocation. Calls are synchronous;
/// callers may access views only until the next call that allocates/grows WASM memory.
#[derive(Default)]
pub struct Handle { core: core::Core, input: Vec<u8>, output: Vec<u8>, error: String, pending: Vec<core::Page>, world: Option<world::World>, physics:Option<physics::Physics>, physics_words:Vec<f64>, queries:traversal::Queries, matches:match_state::Matches, flights:flight::Flights, combats:combat::Combats, brains:ai::Brains, profiles:ai_profile::Profiles, rigs:rig::Rigs }
/// Running-gear presentation rigs: create from gear words (0 on error), pose into the output (link then wheel-buffer
/// instances), destroy.
#[no_mangle]
pub unsafe extern "C" fn engine_rig_create(handle:*mut Handle)->u32 {let h=&mut *handle;match h.rigs.create(&h.physics_words){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn engine_rig_destroy(handle:*mut Handle,id:u32) {(*handle).rigs.remove(id);}
#[no_mangle]
pub unsafe extern "C" fn engine_rig_pose(handle:*mut Handle,id:u32)->u32 {let h=&mut *handle;let result=match h.rigs.get(id){Ok(r)=>rig::pose(r,&h.physics_words,&mut h.output),Err(e)=>Err(e)};status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn engine_profile_create(handle:*mut Handle)->u32 {let h=&mut *handle;match h.profiles.create(&h.physics_words,&h.matches){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn engine_profile_destroy(handle:*mut Handle,id:u32) {(*handle).profiles.remove(id);}
#[no_mangle]
pub unsafe extern "C" fn engine_profile_command(handle:*mut Handle,id:u32,op:u32)->u32 {let h=&mut *handle;let result=if op==4 {h.profiles.resident(id,&h.physics_words,&mut h.matches,&h.combats,&mut h.flights,&mut h.queries,h.physics.as_ref(),&mut h.output)}else{h.profiles.command(id,op,&h.physics_words,&h.matches,&h.combats,&mut h.output)};status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn engine_ai_create(handle:*mut Handle)->u32 {let h=&mut *handle;match h.brains.create(&h.physics_words,&h.matches){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn engine_ai_destroy(handle:*mut Handle,id:u32) {(*handle).brains.remove(id);}
#[no_mangle]
pub unsafe extern "C" fn engine_ai_command(handle:*mut Handle,id:u32,op:u32)->u32 {let h=&mut *handle;let result=if op==4 {h.brains.resident(id,&h.physics_words,&mut h.matches,&h.combats,&mut h.flights,&mut h.queries,h.physics.as_ref(),&mut h.output)}else{h.brains.command(id,op,&h.physics_words,&mut h.matches,&h.combats,&mut h.output)};status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn engine_combat_create(handle:*mut Handle)->u32 {let h=&mut *handle;match h.combats.create(&h.physics_words){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn engine_combat_destroy(handle:*mut Handle,id:u32) {(*handle).combats.remove(id);}
#[no_mangle]
pub unsafe extern "C" fn engine_combat_command(handle:*mut Handle,id:u32,op:u32)->u32 {let h=&mut *handle;let result=h.combats.command(id,op,&h.physics_words,&mut h.queries,h.physics.as_ref(),&mut h.output);status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn engine_flight_create(handle:*mut Handle)->u32 {let h=&mut *handle;match h.flights.create(&h.physics_words){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn engine_flight_destroy(handle:*mut Handle,id:u32) {(*handle).flights.remove(id);}
#[no_mangle]
pub unsafe extern "C" fn engine_flight_command(handle:*mut Handle,context:u32,op:u32,id:u32)->u32 {let h=&mut *handle;let result=h.flights.command(context,op,id,&h.physics_words,&mut h.queries,h.physics.as_ref(),&mut h.output);status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn engine_match_create(handle:*mut Handle)->u32 {let h=&mut *handle;match h.matches.create(&h.physics_words){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn engine_match_destroy(handle:*mut Handle,id:u32) {let h=&mut *handle;h.brains.remove_match(id);h.profiles.remove_match(id);h.matches.remove(id);}
#[no_mangle]
pub unsafe extern "C" fn engine_match_command(handle:*mut Handle,id:u32,op:u32)->u32 {let h=&mut *handle;let result=if op==65 {tick::head(h,id)}else if op==66 {tick::chassis(h,id)}else if op==69 {tick::solver(h,id)}else if op==67||op==68||op==70 {tick::tail(h,id,op==68,op==70)}else if (59..62).contains(&op) {h.matches.canonical_command(id,op,&h.physics_words,&h.combats,&h.flights,h.physics.as_ref(),&h.brains,&h.profiles,&mut h.output)}else{h.matches.command(id,op,&h.physics_words,&mut h.combats,&mut h.queries,h.physics.as_mut(),&mut h.flights,&mut h.output)};status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_retain(handle:*mut Handle)->u32 {let h=&mut *handle;match h.queries.retain(&h.output){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_scene(handle:*mut Handle)->u32 {let h=&mut *handle;match h.queries.scene(&h.physics_words){Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_release(handle:*mut Handle,id:u32,scene:u32) {let h=&mut *handle;h.queries.release(id,scene);}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_run(handle:*mut Handle,id:u32,op:u32)->u32 {let h=&mut *handle;let result=h.queries.run(id,op,&h.physics_words,&mut h.output);status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_world(handle:*mut Handle)->u32 {let h=&mut *handle;let result=h.physics.as_ref().ok_or("Engine physics is absent".into()).and_then(|p|h.queries.world(&h.physics_words,p));match result{Ok(id)=>id,Err(e)=>{h.error=e;0}}}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_world_sync(handle:*mut Handle,id:u32)->u32 {let h=&mut *handle;let result=h.physics.as_ref().ok_or("Engine physics is absent".into()).and_then(|p|h.queries.world_sync(id,p));match result{Ok(changed)=>if changed{2}else{0},Err(e)=>status(h,Err(e))}}
#[no_mangle]
pub unsafe extern "C" fn terrain_query_world_run(handle:*mut Handle,id:u32,op:u32)->u32 {let h=&mut *handle;let result=h.physics.as_ref().ok_or("Engine physics is absent".into()).and_then(|p|h.queries.world_run(id,op,&h.physics_words,p,&mut h.output));status(h,result)}
#[no_mangle]
pub unsafe extern "C" fn engine_physics_input(handle:*mut Handle,length:usize)->*mut f64 {let h=&mut *handle;h.physics_words.resize(length,0.);h.physics_words.as_mut_ptr()}
#[no_mangle]
pub unsafe extern "C" fn engine_physics_enable(handle:*mut Handle)->u32 {let h=&mut *handle;if h.physics.is_some(){return status(h,Err("Engine physics already exists".into()));}h.physics=Some(physics::Physics::new());0}
#[no_mangle]
pub unsafe extern "C" fn engine_physics_destroy(handle:*mut Handle) {(*handle).physics=None;}
#[no_mangle]
pub unsafe extern "C" fn engine_physics_command(handle:*mut Handle,op:u32,id:u32)->u32 {let h=&mut *handle;let result=h.physics.as_mut().ok_or("Engine physics is absent".into()).and_then(|p|p.command(op,id,&h.physics_words,&mut h.output));status(h,result)}
#[no_mangle]
pub extern "C" fn terrain_create() -> *mut Handle { record_panics(); Box::into_raw(Box::new(Handle::default())) }
/// panic = "abort" traps without a message; the hook keeps the last panic's
/// message and location readable from the (still intact) linear memory.
static PANIC: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
fn record_panics() { static HOOK: std::sync::Once = std::sync::Once::new(); HOOK.call_once(|| std::panic::set_hook(Box::new(|info| { if let Ok(mut m) = PANIC.lock() { *m = info.to_string(); } }))); }
#[no_mangle]
pub extern "C" fn terrain_panic() -> *const u8 { PANIC.lock().map_or(std::ptr::null(), |m| m.as_ptr()) }
#[no_mangle]
pub extern "C" fn terrain_panic_len() -> usize { PANIC.lock().map_or(0, |m| m.len()) }
#[no_mangle]
pub unsafe extern "C" fn terrain_destroy(handle: *mut Handle) { drop(Box::from_raw(handle)); }
#[no_mangle]
pub unsafe extern "C" fn terrain_input(handle: *mut Handle, length: usize) -> *mut u8 { let h = &mut *handle; h.input.resize(length,0); h.input.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn terrain_initialize(handle: *mut Handle) -> u32 { let h = &mut *handle; match wire::initialize(&h.input) { Ok(core)=>{h.core=core;h.input=Vec::new();h.error.clear();0},Err(error)=>{h.error=error;1} } }
#[no_mangle]
pub unsafe extern "C" fn terrain_compile(handle: *mut Handle) -> u32 {
    let h = &mut *handle;
    match wire::compile(&mut h.core,&h.input) {
        Ok(pages)=>{ h.pending=pages; h.error.clear(); 0 },
        Err(error)=>{ h.core.recycle_output(); h.error=error; 1 }
    }
}
#[no_mangle]
pub unsafe extern "C" fn terrain_pack(handle: *mut Handle) { let h = &mut *handle; packet::pack(&h.core,&h.pending).encode(&mut h.output); h.pending.clear(); h.core.recycle_output(); }
#[no_mangle]
pub unsafe extern "C" fn terrain_pack_flat(handle: *mut Handle) { let h = &mut *handle; packet::pack_flat(&h.core,&h.pending).encode(&mut h.output); h.pending.clear(); h.core.recycle_output(); }
#[no_mangle]
pub unsafe extern "C" fn terrain_reset_construction(handle: *mut Handle) -> u32 { let h = &mut *handle; match h.core.reset_construction() { Ok(())=>0,Err(error)=>{h.error=error;1} } }
#[no_mangle]
pub unsafe extern "C" fn terrain_output(handle: *const Handle) -> *const u8 { (*handle).output.as_ptr() }
#[no_mangle]
pub unsafe extern "C" fn terrain_output_len(handle: *const Handle) -> usize { (*handle).output.len() }
#[no_mangle]
pub unsafe extern "C" fn terrain_error(handle: *const Handle) -> *const u8 { (*handle).error.as_ptr() }
#[no_mangle]
pub unsafe extern "C" fn terrain_error_len(handle: *const Handle) -> usize { (&(*handle).error).len() }
#[no_mangle]
pub unsafe extern "C" fn terrain_fallbacks(handle: *const Handle) -> u32 { (*handle).core.fallback_count }

fn status(h: &mut Handle, result: core::Outcome<()>) -> u32 { match result { Ok(())=>{h.error.clear();0},Err(error)=>{h.error=error;1} } }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_enable(handle: *mut Handle) -> u32 {
    let h = &mut *handle; if !h.core.canonical_construction { return status(h,Err("World requires canonical construction".into())); }
    h.world = Some(world::World::new(std::mem::take(&mut h.core))); 0
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_ingest(handle: *mut Handle) -> u32 { let h = &mut *handle; let result = h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.ingest(&h.input)); status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_begin(handle: *mut Handle, revision: u32) -> u32 { let h=&mut *handle; let result=h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.begin(revision,&h.input)); status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_commit(handle: *mut Handle) -> u32 { let h=&mut *handle; let result=h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.commit()); status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_abort(handle: *mut Handle) { if let Some(world)=&mut (*handle).world { world.abort(); } }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_compact_pages(handle: *mut Handle) -> u32 { let h=&mut *handle;let result=h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.compact_pages());status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_detach(handle: *mut Handle) -> u32 { let h=&mut *handle;let result=h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.detach());status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_recut_body(handle: *mut Handle, id: u32, field: u32) -> u32 { let h=&mut *handle;let result=h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.recut_body(id,field));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_body_words(handle: *mut Handle, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.body_words(preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_masks(handle: *mut Handle, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.mask_words(preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_export_body(handle: *mut Handle, id: u32, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.export_body(id,preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_body_surface(handle: *mut Handle, id: u32, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.body_surface(id,preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_body_query(handle: *mut Handle, id: u32, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.body_query(id,preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_body_volumes(handle: *mut Handle, id: u32, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.body_volumes(id,preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_transaction_volumes(handle: *mut Handle) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.transaction_volumes(&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_append_body_fields(handle: *mut Handle) -> u32 { let h=&mut *handle;let result=h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.append_body_fields(&h.input));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_publication(handle: *mut Handle) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.publication(&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_audit(handle: *mut Handle) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.audit());status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_audit_step(handle: *mut Handle) -> u32 { let h=&mut *handle;match h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.audit_step()) { Ok(done)=>if done {0}else{2},Err(error)=>status(h,Err(error)) } }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_body_colliders(handle: *mut Handle, id: u32, preview: u32) -> u32 { let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.body_colliders(id,preview!=0,&mut h.output));status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_connect(handle: *mut Handle) -> u32 { let h = &mut *handle; let result = h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.connect()); status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_connect_step(handle: *mut Handle) -> u32 { let h=&mut *handle;match h.world.as_mut().ok_or("Missing resident world".into()).and_then(|w|w.connect_step()) { Ok(done)=>if done {0}else{2},Err(error)=>status(h,Err(error)) } }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_gpu_recipes(handle: *mut Handle, from: usize) -> u32 { let h = &mut *handle; let result = h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.gpu_recipes(from,&mut h.output)); status(h,result) }
#[no_mangle]
pub unsafe extern "C" fn terrain_world_gpu_surface(handle: *mut Handle, brick: u32, component: u32, anchored: u32, preview: u32) -> u32 {
    let h=&mut *handle;let selection=feed::Selection { brick,component,anchored:anchored!=0,preview:preview!=0,origin:[0.;3] };
    let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.gpu_surface(&selection,&mut h.output));status(h,result)
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_query_chunk(handle: *mut Handle, brick: u32, component: u32, anchored: u32, preview: u32, x: f64, y: f64, z: f64) -> u32 {
    let h=&mut *handle;let selection=feed::Selection { brick,component,anchored:anchored!=0,preview:preview!=0,origin:[x,y,z] };
    let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.query_chunk(&selection,&mut h.output));status(h,result)
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_query_bvh(handle: *mut Handle, brick: u32, component: u32, anchored: u32, preview: u32, x: f64, y: f64, z: f64) -> u32 {
    let code=terrain_world_query_chunk(handle,brick,component,anchored,preview,x,y,z);if code!=0 { return code; }
    let h=&mut *handle;let result=query::append_bvh(&mut h.output);status(h,result)
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_gpu_volumes(handle: *mut Handle, preview: u32, changed_only: u32) -> u32 {
    let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.gpu_volumes(preview!=0,changed_only!=0,&mut h.output));status(h,result)
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_components(handle: *mut Handle, preview: u32) -> u32 {
    let h=&mut *handle;let result=h.world.as_ref().ok_or("Missing resident world".into()).and_then(|w|w.component_words(preview!=0,&mut h.output));status(h,result)
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_export(handle: *mut Handle) -> u32 {
    let h = &mut *handle; let Some(world) = &h.world else { return status(h,Err("Missing resident world".into())); };
    let pages: Vec<core::Page> = world.pages.iter().flatten().cloned().collect(); packet::pack_flat(&world.core,&pages).encode(&mut h.output); 0
}
#[no_mangle]
pub unsafe extern "C" fn terrain_world_stat(handle: *const Handle, index: u32) -> u32 {
    let Some(w) = &(*handle).world else { return 0; }; let g = &w.graph;
    match index {
        0=>w.core.vertices.len() as u32,1=>g.regions.len() as u32,2=>g.components,3=>g.portals,4=>g.boundary.len() as u32,5=>g.edges,6=>g.unpaired,7=>g.orientation_errors,
        8=>g.roots.iter().filter(|&&r|g.anchored[r as usize]).count() as u32,
        9=>g.roots.iter().enumerate().filter(|&(i,&r)|i == r as usize && !g.anchored[i]).count() as u32,
        10=>w.core.faces.len() as u32,11=>w.core.face_vertices.len() as u32,12=>w.core.region_links.len() as u32,13=>w.core.region_signs.len() as u32,14=>w.core.planes.len() as u32,
        _=>0,
    }
}
