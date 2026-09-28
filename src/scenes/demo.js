/**
 * Demo scene — a small studio "showroom", in the spirit of the reference editor's
 * hero scene: a vehicle built from primitives on a reflective floor, a key/fill
 * light rig, a camera entity, and a colonnade that demonstrates *instanced*
 * rendering (one draw call for 64 pillars).
 *
 * It is also the project's smoke test: if this scene renders, the whole frame graph
 * works.
 */

import { Entity } from '../scene/entity.js';
import { migrateComponent } from '../scene/components.js';
import { primitiveGeometry, PRIMITIVES } from '../scene/primitives.js';

export function buildDemoScene(app) {
  const { scene, assets } = app;
  const defaults = app.defaults;
  scene.name = 'Showroom';
  scene.settings.sky = {
    ...scene.settings.sky,
    zenith: [0.05, 0.06, 0.09],
    horizon: [0.1, 0.11, 0.14],
    ground: [0.03, 0.03, 0.04],
    sunDirection: [0.42, 0.72, 0.55],
    sunColor: [1, 0.95, 0.88],
    sunIntensity: 7,
    turbidity: 1.1,
    exposure: 1.0,
    groundBlend: 0.1,
    backgroundIntensity: 0.4,
    iblIntensity: 0.5
  };
  scene.settings.render.ambient = [0.03, 0.035, 0.045];
  scene.settings.render.fogColor = [0.045, 0.05, 0.065];
  scene.settings.render.exposure = 0.95;
  scene.settings.render.bloom = true;
  scene.settings.render.bloomStrength = 0.05;
  scene.settings.render.ssao = !!app.ctx.caps.limits.depthTexture;
  scene.settings.render.contrast = 1.08;
  scene.settings.render.vignette = 0.5;

  const model = (kind, name) => {
    const existing = assets.byType('model').find((a) => a.primitive === kind);
    if (existing) return existing.id;
    return assets.createModel(name || PRIMITIVES[kind].label, primitiveGeometry(kind), { primitive: kind }).id;
  };

  const render = (mesh, material, extra = {}) => migrateComponent('render', { mesh, material, ...extra });

  // `defaults.car` is the default floor material: dark, glossy, and the only
  // surface that reflects the ring of pillars and the car, so it carries most of
  // the perceived lighting in the scene.
  const stoneMat = app.assets.createMaterial('Column Stone', {
    diffuse: [0.44, 0.42, 0.39, 1], roughness: 0.78
  });

  /* ------------------------------------------------------------ environment */

  const floor = new Entity({ name: 'Floor', position: [0, 0, 0], scale: [3, 1, 3] });
  floor.addComponent('render', render(model('plane', 'Floor Plane'), defaults.car.id, { castShadows: false, receiveShadows: true }));
  scene.root.addChild(floor);

  // Everything on the turntable sits this far above y=0, so the deck never clips
  // the wheels.
  const DECK = 0.14;

  const turntable = new Entity({ name: 'Turntable', position: [0, DECK * 0.5, 0], scale: [3.4, DECK, 3.4] });
  turntable.addComponent('render', render(model('cylinder', 'Turntable'), defaults.chrome.id, { castShadows: true, receiveShadows: true }));
  scene.root.addChild(turntable);

  // A colonnade: a ring of pillars around the car, drawn in a single instanced call.
  const colonnade = new Entity({ name: 'Colonnade (instanced)', position: [0, 1.35, 0], scale: [0.42, 2.7, 0.42] });
  colonnade.addComponent('render', render(model('box', 'Pillar'), stoneMat.id, {
    instanceCount: 28, instanceSpread: 7.5, instanceLayout: 'ring',
    castShadows: true, receiveShadows: true
  }));
  scene.root.addChild(colonnade);

  /* ------------------------------------------------------------------ car */

  // The capsule primitive is 0.5 wide, 1 long and 0.5 deep with its long axis on Y,
  // so the body is a capsule turned on its side: local Y becomes world Z, and the
  // local X/Z scales become the car's width/height. That gives a single smooth
  // loaf with rounded nose and tail instead of a stack of boxes.
  const BODY = { len: 3.4, wide: 1.6, tall: 0.66, y: DECK + 0.46 };
  const car = new Entity({
    name: 'Concept Car', position: [0, BODY.y, 0], rotation: [90, 0, 0],
    scale: [BODY.wide * 2, BODY.len, BODY.tall * 2]
  });
  car.addComponent('render', render(model('capsule', 'Body'), defaults.paint.id, { castShadows: true, receiveShadows: true }));
  scene.root.addChild(car);

  const cabin = new Entity({ name: 'Cabin', position: [0, BODY.y + 0.3, -0.35], scale: [1.3, 0.62, 1.5] });
  cabin.addComponent('render', render(model('sphere', 'Glass Shell'), defaults.glass.id, { castShadows: false, receiveShadows: true }));
  scene.root.addChild(cabin);

  const nose = new Entity({ name: 'Nose', position: [0, DECK + 0.16, BODY.len * 0.42], scale: [2.2, 0.18, 0.7] });
  nose.addComponent('render', render(model('box', 'Nose Block'), defaults.paint.id));
  scene.root.addChild(nose);

  const splitter = new Entity({ name: 'Splitter', position: [0, DECK + 0.07, BODY.len * 0.46], scale: [2.4, 0.12, 0.5] });
  splitter.addComponent('render', render(model('box', 'Splitter Block'), defaults.plastic.id));
  scene.root.addChild(splitter);

  const WHEEL_R = 0.36;
  for (const [x, z, name] of [[-0.9, 1.05, 'Wheel FL'], [0.9, 1.05, 'Wheel FR'], [-0.9, -1.1, 'Wheel RL'], [0.9, -1.1, 'Wheel RR']]) {
    const wheel = new Entity({ name, position: [x, DECK + WHEEL_R, z], rotation: [0, 0, 90], scale: [WHEEL_R * 2, 0.32, WHEEL_R * 2] });
    wheel.addComponent('render', render(model('cylinder', 'Wheel'), defaults.rubber.id, { castShadows: true, receiveShadows: true }));
    scene.root.addChild(wheel);

    const rim = new Entity({ name: `${name} Rim`, position: [x * 1.04, DECK + WHEEL_R, z * 1.04], rotation: [0, 0, 90], scale: [0.46, 0.36, 0.46] });
    rim.addComponent('render', render(model('cylinder', 'Rim'), defaults.chrome.id));
    scene.root.addChild(rim);
  }

  for (const [x, name] of [[-0.55, 'Headlight L'], [0.55, 'Headlight R']]) {
    const lamp = new Entity({ name, position: [x, DECK + 0.3, BODY.len * 0.46], scale: [0.5, 0.14, 0.12] });
    lamp.addComponent('render', render(model('box', 'Lamp Block'), defaults.neon.id, { castShadows: false }));
    scene.root.addChild(lamp);
  }

  const tail = new Entity({ name: 'Tail Light Bar', position: [0, DECK + 0.34, -BODY.len * 0.47], scale: [2.1, 0.13, 0.12] });
  tail.addComponent('render', render(model('box', 'Tail Block'), (() => {
    const m = app.assets.createMaterial('Tail Emissive', { emissive: [1, 0.12, 0.05], emissiveIntensity: 7, diffuse: [0.1, 0.02, 0.02, 1], roughness: 0.4 });
    return m.id;
  })()));
  scene.root.addChild(tail);

  /* ---------------------------------------------------------------- lights */

  const sun = new Entity({ name: 'Key Light', position: [6, 9, 5], rotation: [-42, 38, 0] });
  sun.addComponent('light', migrateComponent('light', {
    type: 'directional',
    color: [1, 0.96, 0.9],
    intensity: 2.4,
    castShadows: true,
    shadowResolution: 2048,
    shadowDistance: 44,
    shadowBias: 0.18
  }));
  scene.root.addChild(sun);

  const fill = new Entity({ name: 'Fill Light', position: [-7, 4, -4] });
  fill.addComponent('light', migrateComponent('light', {
    type: 'omni', color: [0.45, 0.6, 1], intensity: 14, range: 22, castShadows: false
  }));
  scene.root.addChild(fill);

  const rim = new Entity({ name: 'Rim Light', position: [4, 3, -7] });
  rim.addComponent('light', migrateComponent('light', {
    type: 'spot', color: [0.6, 0.9, 1], intensity: 34, range: 18,
    innerConeAngle: 18, outerConeAngle: 34, castShadows: false
  }));
  scene.root.addChild(rim);

  const strip = new Entity({ name: 'Floor Strip', position: [0, 0.03, 4.2], scale: [7, 0.04, 0.18] });
  strip.addComponent('render', render(model('box', 'Strip Block'), defaults.neon.id, { castShadows: false }));
  scene.root.addChild(strip);

  /* ---------------------------------------------------------------- camera */

  const cam = new Entity({ name: 'Showroom Camera', position: [5.4, 2.1, 6.2], rotation: [-8, 41, 0] });
  cam.addComponent('camera', migrateComponent('camera', {
    projection: 'perspective', fov: 42, near: 0.1, far: 200, clearColorMode: 'sky', priority: 0
  }));
  scene.root.addChild(cam);

  /* --------------------------------------------------------------- volume */

  const volume = new Entity({ name: 'Atmosphere', position: [0, 2, 0], scale: [14, 7, 14] });
  // The volume is ray-marched *inside* its bounds mesh, so that mesh must be
  // invisible as geometry: transparent, no depth write, no culling.
  const bounds = app.assets.createMaterial('Volume Bounds', {
    diffuse: [0, 0, 0, 0], metalness: 0, roughness: 1, opacity: 0,
    blend: 'normal', cull: 'none', depthWrite: false, twoSidedLighting: true
  });
  const volAsset = app.assets.createVolume('Studio Haze', 32, (x, y, z) => {
    const d = Math.hypot(x - 0.5, y - 0.5, z - 0.5) * 2;
    const v = Math.max(0, 1 - d);
    return [0.6 * v, 0.72 * v, 0.9 * v, v];
  });
  volume.addComponent('render', render(model('box', 'Haze Box'), bounds.id, { castShadows: false, receiveShadows: false }));
  volume.addComponent('volume', migrateComponent('volume', {
    asset: volAsset.id, color: [0.6, 0.72, 0.9], density: 0.35, steps: 40
  }));
  scene.root.addChild(volume);

  scene.touch('demo');
  app.log.info(`demo scene: ${scene.entities.length} entities, ${assets.count()} assets`);
  return scene;
}
