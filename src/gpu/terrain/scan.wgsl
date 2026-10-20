// Hierarchical exclusive scan. All sums are exact u32 or explicitly flagged.
struct Config { count: u32, reserved0: u32, reserved1: u32, reserved2: u32 }
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(3) var<uniform> config: Config;
@group(0) @binding(4) var<storage, read_write> status: array<atomic<u32>>;
var<workgroup> scratch: array<u32, 256>;

fn checkedAdd(a: u32, b: u32) -> u32 {
  let sum = a + b;
  if (sum < a) { atomicOr(&status[0], 1u); }
  return sum;
}

@compute @workgroup_size(128)
fn scanBlocks(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
  let lane = local.x; let begin = group.x * 256u;
  let a = begin + lane * 2u; let b = a + 1u;
  scratch[lane*2u] = 0u; scratch[lane*2u+1u] = 0u;
  if (a < config.count) { scratch[lane*2u] = input[a]; }
  if (b < config.count) { scratch[lane*2u+1u] = input[b]; }
  workgroupBarrier();
  for (var stride = 1u; stride < 256u; stride *= 2u) {
    let index = (lane + 1u) * stride * 2u - 1u;
    if (index < 256u) { scratch[index] = checkedAdd(scratch[index-stride], scratch[index]); }
    workgroupBarrier();
  }
  if (lane == 0u) { blockSums[group.x] = scratch[255]; scratch[255] = 0u; }
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride /= 2u) {
    let index = (lane + 1u) * stride * 2u - 1u;
    if (index < 256u) {
      let left = scratch[index-stride];
      scratch[index-stride] = scratch[index];
      scratch[index] = checkedAdd(scratch[index], left);
    }
    workgroupBarrier();
  }
  if (a < config.count) { output[a] = scratch[lane*2u]; }
  if (b < config.count) { output[b] = scratch[lane*2u+1u]; }
}

@compute @workgroup_size(128)
fn addBlockOffsets(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i < config.count) { output[i] = checkedAdd(output[i], input[i / 256u]); }
}
