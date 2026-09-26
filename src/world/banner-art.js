import * as THREE from 'three';

// One generated fabric image, with runtime lettering for the actual track.
// Each canvas is owned by Props; the source image remains owned by Assets.
export function texturedBanner(label, accent, fabric, subtitle = '') {
  const finished = finishedBanner(label, fabric);
  if (finished) return finished;
  fabric = fabric?.fabric || fabric;
  if (!fabric?.image) return null;
  const c = document.createElement('canvas'); c.width = 2048; c.height = 512;
  const g = c.getContext('2d');
  if (!g) return null;
  g.drawImage(fabric.image, 0, 0, c.width, c.height);
  g.fillStyle = accent;
  g.globalAlpha = .48;
  g.fillRect(360, 46, 1328, 8); g.fillRect(360, 458, 1328, 8);
  g.globalAlpha = 1;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${label.length > 16 ? 104 : 148}px "Arial Black", Impact, sans-serif`;
  g.lineWidth = 6; g.strokeStyle = '#171511'; g.fillStyle = '#eee7d5';
  const y = subtitle ? 220 : 256;
  g.strokeText(label, 1024, y, 1260); g.fillText(label, 1024, y, 1260);
  if (subtitle) {
    g.font = '700 46px "Arial Narrow", sans-serif';
    g.fillStyle = '#ddba69'; g.fillText(subtitle, 1024, 362, 1200);
  }
  // Carry the cloth grain and wrinkles through the printed letters, too.
  g.globalCompositeOperation = 'multiply'; g.globalAlpha = .18;
  g.drawImage(fabric.image, 0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  return texture;
}

// Complete ImageGen artwork including printed lettering. Only named jumps
// receive an additional small caption; the main design is always image art.
export function finishedBanner(label, assets) {
  const isGantry = label === 'ROAD RASH';
  const image = (isGantry ? assets?.gantry : assets?.atlas)?.image;
  if (!image) return null;
  const c = document.createElement('canvas'); c.width = 2048; c.height = 512;
  const g = c.getContext('2d');
  if (!g) return null;
  if (isGantry) g.drawImage(image, 0, 0, c.width, c.height);
  else {
    const row = label === 'CHECK' || label === 'CHECKPOINT' ? 0
      : label === 'SUNSTRIKE' ? 2 : label === 'RIDGEBACK' ? 3 : 1;
    g.drawImage(image, 0, image.height * row / 4, image.width, image.height / 4,
      0, 0, c.width, c.height);
    if (row === 1 && label !== 'BIG AIR') {
      g.fillStyle = 'rgba(15,14,12,.88)'; g.fillRect(570,410,908,64);
      g.fillStyle = '#eee7d5'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '700 40px "Arial Narrow", sans-serif'; g.fillText(label,1024,443,850);
    }
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 16;
  texture.name = 'generated-banner-' + label;
  return texture;
}
