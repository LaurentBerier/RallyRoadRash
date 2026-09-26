export const GARAGE_ROOM_SCALE=1.35;

// Locally vendored renderer and project-owned world; no CDN at runtime.
export async function loadGarageSplat(renderer, scene) {
  // r160 has the same readback signature but only its synchronous form.
  if (!renderer.readRenderTargetPixelsAsync) renderer.readRenderTargetPixelsAsync = async (...args) => {
    renderer.readRenderTargetPixels(...args); return args[5];
  };
  const { SparkRenderer, SplatMesh } = await import('../../vendor/spark/spark.module.js');
  const response=await fetch('assets/worlds/gritty-death-race-garage.spz',{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Garage world download failed: '+response.status);
  const fileBytes=await response.arrayBuffer();
  const spark = new SparkRenderer({renderer});
  spark.material.fragmentShader = 'precision highp sampler3D;\n' + spark.material.fragmentShader;
  const disposeSpark=()=>{
    spark.autoUpdate=false;clearTimeout(spark.pendingUpdate?.timeoutId);
    for(const view of new Set([spark.defaultView,...spark.autoViewpoints,spark.envViewpoint])) view?.dispose();
    for(const accumulator of new Set([spark.active,...spark.freeAccumulators])) accumulator?.splats.dispose();
    spark.material.dispose();
  };
  const world = new SplatMesh({fileBytes,fileName:'garage.spz'});
  world.rotation.x = Math.PI;
  world.scale.setScalar(2.5*GARAGE_ROOM_SCALE);
  world.position.set(0,1.58*GARAGE_ROOM_SCALE,0);
  scene.add(spark,world);
  try { await world.initialized; }
  catch(error){scene.remove(world,spark);world.dispose();disposeSpark();throw error;}
  return {dispose(){scene.remove(world,spark);world.dispose();disposeSpark();}};
}
