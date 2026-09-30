/**
 * Car template — a driveable showroom built entirely from primitives, with a
 * rigid-body vehicle model behind it.
 *
 * There is no imported mesh. Every panel, wheel and light is a primitive from
 * `PRIMITIVES`, which means the template is a few kilobytes of scene data rather
 * than tens of megabytes of geometry, and it is editable in the inspector like
 * anything else. To use your own car, drop a `.glb` on the window and reparent
 * the wheels — the vehicle model only needs four corner offsets.
 *
 * The dynamics live in `src/sim/vehicle.js` and know nothing about the scene
 * graph. This file binds entity transforms to that state, reads held keys for the
 * driving controls, and hands the editor a tick to call each frame.
 *
 * Controls: W/S throttle and brake, A/D steer, R reset. Driving is a continuous
 * analogue input, so it is polled from the same held-key set the viewport camera
 * already owns; the discrete actions are registered commands like everything else.
 */

import { Entity } from '../scene/entity.js';
import { migrateComponent } from '../scene/components.js';
import { primitiveGeometry, PRIMITIVES } from '../scene/primitives.js';
import { Vehicle } from '../sim/vehicle.js';
import { quat, deg } from '../core/math.js';

/** Geometry and dynamics are described once, in metres, and both read from this. */
export const CAR_SPEC = Object.freeze({
  wheelRadius: 0.34,
  halfTrack: 0.8,
  halfBase: 1.425,
  padRadius: 8.2,
  bodyLength: 4.4,
  bodyWidth: 1.86,
  bodyHeight: 0.62,
  bodyY: 0.58
});

/* Driving keys. Arrows are always free. W and S are shared with the transform
 * gizmo (W move, E rotate, R scale), so they only drive the car when the gizmo is
 * not being dragged — otherwise pressing W to accelerate would also start a gizmo
 * move. Steer uses A/D, which the gizmo does not claim. */
const DRIVE_KEYS = {
  throttle: ['arrowup'],
  throttleAlt: ['w'],
  brake: ['arrowdown'],
  brakeAlt: ['s'],
  left: ['a', 'arrowleft'],
  right: ['d', 'arrowright']
};

/* Scratch quaternions: the tick runs every frame and must not allocate. */
const _rootRot = quat.create();
const _chassisRot = quat.create();
const _steerRot = quat.create();
const _spinRot = quat.create();

/**
 * Build the template into `app.scene`.
 * @returns {{update: (dt:number)=>void, vehicle: Vehicle, reset: ()=>void, root: Entity}}
 */
export function buildCarScene(app) {
  const { scene, assets } = app;
  const defaults = app.defaults;

  const vehicle = new Vehicle({
    wheelRadius: CAR_SPEC.wheelRadius,
    halfTrack: CAR_SPEC.halfTrack,
    halfBase: CAR_SPEC.halfBase,
    boundRadius: CAR_SPEC.padRadius
  });

  scene.name = 'Car Template';
  scene.settings.sky = {
    ...scene.settings.sky,
    zenith: [0.04, 0.05, 0.08],
    horizon: [0.09, 0.1, 0.13],
    ground: [0.025, 0.025, 0.03],
    sunDirection: [0.35, 0.68, 0.5],
    sunColor: [1, 0.96, 0.9],
    sunIntensity: 6,
    turbidity: 1.2,
    exposure: 1.0,
    groundBlend: 0.1,
    backgroundIntensity: 0.35,
    iblIntensity: 0.45
  };
  scene.settings.render.ambient = [0.028, 0.032, 0.042];
  scene.settings.render.fogColor = [0.04, 0.045, 0.06];
  scene.settings.render.exposure = 0.95;
  scene.settings.render.bloom = true;
  scene.settings.render.bloomStrength = 0.05;
  scene.settings.render.ssao = !!app.ctx.caps.limits.depthTexture;
  scene.settings.render.contrast = 1.08;
  scene.settings.render.vignette = 0.55;

  const model = (kind, name) => {
    const existing = assets.byType('model').find((a) => a.primitive === kind);
    if (existing) return existing.id;
    return assets.createModel(name || PRIMITIVES[kind].label, primitiveGeometry(kind), { primitive: kind }).id;
  };
  const render = (mesh, material, extra = {}) => migrateComponent('render', { mesh, material, ...extra });

  /* -------------------------------------------------------------- the pad */

  // The disc is exactly the size the vehicle's soft boundary wall is tuned for,
  // so the car visibly reaches the edge of the surface it is allowed to drive on.
  const padMat = assets.createMaterial('Drive Pad', {
    diffuse: [0.055, 0.06, 0.07, 1], metalness: 0.5, roughness: 0.16
  });
  const pad = new Entity({
    name: 'Drive Pad',
    position: [0, -0.06, 0],
    scale: [CAR_SPEC.padRadius * 2, 0.12, CAR_SPEC.padRadius * 2]
  });
  pad.addComponent('render', render(model('cylinder', 'Pad'), padMat.id, { castShadows: false, receiveShadows: true }));
  scene.root.addChild(pad);

  /* ----------------------------------------------------------------- car */

  // Three nested levels so no transform depends on euler order: the root carries
  // yaw only, the chassis carries pitch and roll, and each wheel nests a steer
  // pivot inside a spin pivot. Flattening these onto one entity each would make
  // the result depend on the engine's rotation convention.
  const root = new Entity({ name: 'Car', position: [0, 0, 0] });
  const chassis = new Entity({ name: 'Chassis', position: [0, 0, 0] });
  root.addChild(chassis);
  scene.root.addChild(root);

  const S = CAR_SPEC;
  const body = new Entity({
    name: 'Body',
    position: [0, S.bodyY, 0],
    // Entity rotations are degrees. The capsule's long axis is local Y, so 90
    // about X lays the body down along world Z.
    rotation: [90, 0, 0],
    scale: [S.bodyWidth * 2, S.bodyLength, S.bodyHeight * 2]
  });
  body.addComponent('render', render(model('capsule', 'Body'), defaults.paint.id, { castShadows: true, receiveShadows: true }));
  chassis.addChild(body);

  const cabin = new Entity({ name: 'Cabin', position: [0, S.bodyY + 0.28, -0.34], scale: [1.44, 0.56, 1.5] });
  cabin.addComponent('render', render(model('sphere', 'Glass Shell'), defaults.glass.id, { castShadows: false, receiveShadows: true }));
  chassis.addChild(cabin);

  const splitter = new Entity({ name: 'Splitter', position: [0, 0.16, S.bodyLength * 0.44], scale: [2.5, 0.1, 0.62] });
  splitter.addComponent('render', render(model('box', 'Splitter Block'), defaults.plastic.id, { castShadows: true }));
  chassis.addChild(splitter);

  const diffuser = new Entity({ name: 'Diffuser', position: [0, 0.2, -S.bodyLength * 0.45], scale: [2.3, 0.14, 0.5] });
  diffuser.addComponent('render', render(model('box', 'Diffuser Block'), defaults.plastic.id, { castShadows: true }));
  chassis.addChild(diffuser);

  for (const [x, name] of [[-0.6, 'Headlight L'], [0.6, 'Headlight R']]) {
    const lamp = new Entity({ name, position: [x, S.bodyY + 0.04, S.bodyLength * 0.45], scale: [0.54, 0.12, 0.14] });
    lamp.addComponent('render', render(model('box', 'Lamp Block'), defaults.neon.id, { castShadows: false }));
    chassis.addChild(lamp);
  }

  // Emissive is tuned for the *lowest* tier, not the highest: with bloom and the
  // full exposure range switched off, an intensity that looks like a lamp on a
  // discrete GPU clips to a flat cream slab.
  const tailMat = assets.createMaterial('Tail Emissive', {
    emissive: [1, 0.12, 0.05], emissiveIntensity: 2.4, diffuse: [0.12, 0.02, 0.02, 1], roughness: 0.4
  });
  const tail = new Entity({ name: 'Tail Light Bar', position: [0, S.bodyY + 0.02, -S.bodyLength * 0.47], scale: [2.2, 0.12, 0.12] });
  tail.addComponent('render', render(model('box', 'Tail Block'), tailMat.id, { castShadows: false }));
  chassis.addChild(tail);

  /* -------------------------------------------------------------- wheels */

  const wheels = [];
  const corners = [
    [-S.halfTrack, S.halfBase, 'FL'],
    [S.halfTrack, S.halfBase, 'FR'],
    [-S.halfTrack, -S.halfBase, 'RL'],
    [S.halfTrack, -S.halfBase, 'RR']
  ];
  for (const [x, z, tag] of corners) {
    // Hung off the root, not the chassis, so body pitch and roll do not tip the
    // wheels with it — they stay on the ground.
    const steer = new Entity({ name: `Wheel ${tag}`, position: [x, S.wheelRadius, z] });
    const spin = new Entity({ name: `${tag} Spin`, position: [0, 0, 0] });
    steer.addChild(spin);

    const tyre = new Entity({
      name: `${tag} Tyre`,
      rotation: [0, 0, 90],
      scale: [S.wheelRadius * 2, 0.3, S.wheelRadius * 2]
    });
    tyre.addComponent('render', render(model('cylinder', 'Tyre'), defaults.rubber.id, { castShadows: true, receiveShadows: true }));
    spin.addChild(tyre);

    const rim = new Entity({
      name: `${tag} Rim`,
      rotation: [0, 0, 90],
      scale: [S.wheelRadius * 1.25, 0.34, S.wheelRadius * 1.25]
    });
    rim.addComponent('render', render(model('cylinder', 'Rim'), defaults.chrome.id, { castShadows: true }));
    spin.addChild(rim);

    root.addChild(steer);
    wheels.push({ steer, spin, tyre, rim });
  }

  /* --------------------------------------------------------------- lights */

  const sun = new Entity({ name: 'Key Light', position: [7, 10, 6], rotation: [-44, 40, 0] });
  sun.addComponent('light', migrateComponent('light', {
    type: 'directional',
    color: [1, 0.96, 0.9],
    intensity: 2.5,
    castShadows: true,
    shadowResolution: 2048,
    shadowDistance: 46,
    shadowBias: 0.18
  }));
  scene.root.addChild(sun);

  const fill = new Entity({ name: 'Fill Light', position: [-6, 4, -5], rotation: [-18, -125, 0] });
  fill.addComponent('light', migrateComponent('light', {
    type: 'directional', color: [0.55, 0.72, 1], intensity: 0.5, castShadows: false
  }));
  scene.root.addChild(fill);

  const cam = new Entity({ name: 'Showroom Camera', position: [4.6, 1.9, 5.2] });
  cam.addComponent('camera', migrateComponent('camera', { fov: 48, near: 0.05, far: 400 }));
  scene.root.addChild(cam);

  /* -------------------------------------------------------------- driving */

  const held = (names) => {
    const keys = app.viewport?.keys;
    if (!keys) return false;
    for (const n of names) if (keys.has(n)) return true;
    return false;
  };

  const controller = {
    vehicle,
    root,
    update(dt) {
      // W/S belong to the gizmo while a drag is in flight; the arrows never do.
      const gizmoBusy = !!app.gizmo?.drag;
      const throttle = (held(DRIVE_KEYS.throttle) || (!gizmoBusy && held(DRIVE_KEYS.throttleAlt))) ? 1 : 0;
      const brake = (held(DRIVE_KEYS.brake) || (!gizmoBusy && held(DRIVE_KEYS.brakeAlt))) ? 1 : 0;
      const steer = (held(DRIVE_KEYS.right) ? 1 : 0) - (held(DRIVE_KEYS.left) ? 1 : 0);
      vehicle.setInput({ throttle, brake, steer });
      vehicle.update(dt);

      root.position[0] = vehicle.x;
      root.position[2] = vehicle.z;
      // Entity stores a quaternion; `rotation` is a *derived* euler array, so
      // assigning into it is a no-op. These are degrees, the model is radians.
      root.quaternion = quat.fromEuler(_rootRot, 0, deg(vehicle.yaw), 0);
      chassis.quaternion = quat.fromEuler(_chassisRot, deg(vehicle.pitch), 0, deg(vehicle.roll));

      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheels[i];
        const v = wheels[i];
        v.steer.quaternion = quat.fromEuler(_steerRot, 0, deg(w.steer), 0);
        v.spin.quaternion = quat.fromEuler(_spinRot, deg(w.spin), 0, 0);
        // Sag is a load-transfer cue, so the body visibly settles.
        v.steer.position[1] = S.wheelRadius - w.sagSmooth;
      }

      // The editor is event driven; a moving car is not.
      if (throttle || brake || steer || Math.abs(vehicle.speed) > 0.01) app.requestRender();
    },
    reset() {
      vehicle.reset(0, 0, 0);
      root.position[0] = 0;
      root.position[2] = 0;
      root.quaternion = quat.fromEuler(_rootRot, 0, 0, 0);
      chassis.quaternion = quat.fromEuler(_chassisRot, 0, 0, 0);
      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheels[i];
        wheels[i].steer.quaternion = quat.fromEuler(_steerRot, 0, 0, 0);
        wheels[i].spin.quaternion = quat.fromEuler(_spinRot, 0, 0, 0);
        wheels[i].steer.position[1] = S.wheelRadius;
      }
      app.requestRender();
      app.log.info('car reset');
    },
    /** The root entity, for the smoke test. */
    get wheels() { return wheels; }
  };

  app.car = controller;
  app.log.info('car template ready — W/S throttle, A/D steer, R reset');
  return controller;
}
