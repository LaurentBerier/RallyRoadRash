import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VehicleBodyLOD } from '../src/game/vehicle-lod.js';

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
const low = new THREE.Group(), high = new THREE.Group();
let requests = 0, switches = 0;
const lod = new VehicleBodyLOD(low, () => requests++, () => switches++);
const at = distance => {
  camera.position.set(0, 0, distance);
  camera.updateMatrixWorld(true); lod.updateMatrixWorld(true); lod.update(camera);
};
at(100); assert.equal(requests, 0, 'distant cars do not download the large maps');
at(35); at(34); assert.equal(requests, 1, 'nearby cars request once');
assert.equal(low.visible, true, 'low remains visible during streaming');
lod.setHigh(high);
at(10); assert.equal(high.visible, true); assert.equal(low.visible, false);
at(27); assert.equal(high.visible, true);
at(29); assert.equal(low.visible, true); assert.equal(high.visible, false);
at(25); assert.equal(low.visible, true, 'hysteresis prevents threshold flicker');
at(23); assert.equal(high.visible, true);
camera.zoom = 4; at(70); assert.equal(high.visible, true, 'telephoto view retains detail');
camera.zoom = 1; camera.fov = 20; at(60); assert.equal(high.visible, true, 'narrow FOV retains detail');
assert.equal(requests, 1); assert.equal(switches, 3);
const fallback = new VehicleBodyLOD(new THREE.Group(), () => { fallback.state = 'failed'; });
fallback.update(camera); fallback.update(camera);
assert.equal(fallback.low.visible, true, 'failed high download leaves visible low model');
assert.equal(fallback.state, 'failed');
console.log('vehicle-lod: streaming, distance, zoom, FOV, hysteresis and fallback PASS');
