import * as THREE from 'three';

// Texture LODs share the same silhouette and wheel fit. Prefetch before the
// transition; hysteresis prevents repeated swaps at a nearly fixed distance.
export class VehicleBodyLOD extends THREE.LOD {
  constructor(low, requestHigh, onLevel) {
    super();
    this.name = 'carcass';
    this.low = low;
    this.high = null;
    this.state = 'idle';
    this.requestHigh = requestHigh;
    this.onLevel = onLevel;
    this.active = low;
    this.addLevel(low, 0);
  }

  setHigh(high) {
    this.high = high;
    this.state = 'ready';
    this.levels.length = 0;
    this.addLevel(high, 0);
    this.addLevel(this.low, 28, 0.15);
    high.visible = false;
  }

  update(camera) {
    eye.setFromMatrixPosition(camera.matrixWorld);
    center.setFromMatrixPosition(this.matrixWorld);
    // Respect zoom and FOV: a telephoto showroom view needs the same detail as
    // a physically close chase camera. Distances are equivalent at 60° FOV.
    const fovScale = camera.isPerspectiveCamera
      ? Math.tan(camera.fov * Math.PI / 360) / Math.tan(Math.PI / 6) : 1;
    this.distance = eye.distanceTo(center) * fovScale / Math.max(camera.zoom, 0.001);
    if (this.state === 'idle' && this.distance < 40) {
      this.state = 'loading';
      this.requestHigh();
    }
    const threshold = this.active === this.high ? 28 : 28 * 0.85;
    const next = this.high && this.distance < threshold ? this.high : this.low;
    this.low.visible = next === this.low;
    if (this.high) this.high.visible = next === this.high;
    this._currentLevel = this.high && next === this.low ? 1 : 0;
    if (next !== this.active) {
      this.active = next;
      this.onLevel?.(next);
    }
  }
}

const eye = new THREE.Vector3(), center = new THREE.Vector3();
