/**
 * Vehicle dynamics — a small rigid-body model for a car on a flat plane.
 *
 * Deliberately arcade: enough real behaviour that weight transfer, grip and yaw
 * read correctly on screen (squat under power, dive under brakes, body roll into
 * a corner, wheels that steer and spin at the right rates), and nothing more. It
 * is not a tyre model and does not claim to be one.
 *
 * It is also deliberately free of any dependency on the renderer, the scene graph
 * or the editor: it reads and writes plain numbers, so it can be stepped in a test
 * with no browser at all. The scene builder binds entity transforms to it.
 *
 * Integration is a fixed-timestep accumulator, so the same wall-clock second
 * produces the same result at 15 fps as at 144 fps.
 */

import { clamp, damp, lerp } from '../core/math.js';

export const GRAVITY = 9.81;

/** Wheel order is [front-left, front-right, rear-left, rear-right] everywhere. */
export const WHEELS = ['FL', 'FR', 'RL', 'RR'];

export const DEFAULT_TUNING = Object.freeze({
  mass: 1770,          // kg
  halfTrack: 0.8,      // m, half of 1.60
  halfBase: 1.425,     // m, half of a 2.85 wheelbase
  maxSteer: 0.55,      // rad at the road wheel
  wheelRadius: 0.34,   // m
  power: 375000,       // W, ~500 hp
  maxTractionG: 0.8,   // traction ceiling at standstill, before power limiting
  maxLateralG: 1.15,   // tyre grip ceiling, cornering is limited by this
  brakeDecel: 12,      // m/s^2 at full brake
  dragC: 0.62,         // combined aero drag coefficient
  rollC: 0.016,        // rolling resistance coefficient
  grip: 5.5,           // lateral grip rate, 1/s
  yawFactor: 1.15,
  boundRadius: 8.2,    // m, soft wall keeping the car on the floor disc
  boundRestitution: 0.35
});

const SUBSTEP = 1 / 120;
const MAX_SUBSTEPS = 12;
/** Below this the car is considered stopped; brakes park it instead of reversing. */
const CREEP = 0.15;
const STOP_EPS = 0.02;

const makeWheel = () => ({ steer: 0, spin: 0, sag: 0, sagSmooth: 0 });

export class Vehicle {
  constructor(tuning = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };

    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.yawRate = 0;
    this.vx = 0;
    this.vz = 0;

    this.pitch = 0;
    this.roll = 0;
    this.wheelSpin = 0;

    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;

    this.speed = 0;      // signed forward speed, m/s
    this.latG = 0;
    this.lonG = 0;
    this.rpm = 850;
    this.gear = 1;

    this.wheels = WHEELS.map(makeWheel);
    this._acc = 0;
  }

  /** Place the car and clear all motion. */
  reset(x = 0, z = 0, yaw = 0) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.yawRate = 0;
    this.vx = 0;
    this.vz = 0;
    this.pitch = 0;
    this.roll = 0;
    this.wheelSpin = 0;
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.speed = 0;
    this.latG = 0;
    this.lonG = 0;
    this.rpm = 850;
    this.gear = 1;
    this._acc = 0;
    for (const w of this.wheels) {
      w.steer = 0;
      w.spin = 0;
      w.sag = 0;
      w.sagSmooth = 0;
    }
  }

  /** @param {{throttle?:number, brake?:number, steer?:number}} input each 0..1, steer -1..1 */
  setInput({ throttle, brake, steer } = {}) {
    if (throttle !== undefined) this.throttle = clamp(throttle, 0, 1);
    if (brake !== undefined) this.brake = clamp(brake, 0, 1);
    if (steer !== undefined) this.steer = clamp(steer, -1, 1);
  }

  /** Advance by wall-clock seconds, in fixed substeps. */
  update(dt) {
    this._acc += Math.min(dt, 0.5);
    let steps = 0;
    while (this._acc >= SUBSTEP && steps < MAX_SUBSTEPS) {
      this._step(SUBSTEP);
      this._acc -= SUBSTEP;
      steps++;
    }
    // Below roughly 8 fps the fixed substeps alone cannot cover a frame. Spending
    // the backlog in one larger step keeps simulated time equal to wall-clock
    // time instead of quietly running the car in slow motion - which is exactly
    // what a software rasteriser would otherwise see.
    if (this._acc > 1e-6) {
      this._step(this._acc);
      this._acc = 0;
    }
  }

  /** One fixed step. Mutates state in place; allocates nothing. */
  _step(h) {
    const t = this.tuning;

    // Body frame on the ground plane. +Z is forward, matching the scene builders.
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const fwdX = sy, fwdZ = cy;
    const rightX = cy, rightZ = -sy;

    let fwdV = this.vx * fwdX + this.vz * fwdZ;
    let latV = this.vx * rightX + this.vz * rightZ;
    let absV = Math.hypot(this.vx, this.vz);

    // Traction-capped, power-limited drive. Capping before dividing by speed is
    // what stops the car accelerating without limit at 0 m/s.
    let aLong = 0;
    if (this.throttle > 0) {
      const maxTraction = t.mass * GRAVITY * t.maxTractionG;
      const fLong = Math.min(maxTraction, t.power / Math.max(1, absV)) * this.throttle;
      aLong = fLong / t.mass;
      if (fwdV < 0 && absV > 0.5) aLong = 0;   // rolling backwards: no instant reversal
    }

    let aBrake = 0;
    if (this.brake > 0 && Math.abs(fwdV) > CREEP) aBrake = -t.brakeDecel * this.brake * Math.sign(fwdV);

    if (absV > 0.01) {
      const dec = (t.dragC * absV * absV + t.rollC * t.mass * GRAVITY) / t.mass;
      const dv = dec * h;
      if (absV - dv <= STOP_EPS) {
        this.vx = 0;
        this.vz = 0;
        absV = 0;
      } else {
        const inv = (absV - dv) / absV;
        this.vx *= inv;
        this.vz *= inv;
      }
    }

    this.vx += fwdX * (aLong + aBrake) * h;
    this.vz += fwdZ * (aLong + aBrake) * h;

    // The brake must not push the car through zero and into reverse.
    if (aBrake !== 0) {
      const nowV = this.vx * fwdX + this.vz * fwdZ;
      if (Math.sign(nowV) !== Math.sign(fwdV) && fwdV !== 0) {
        this.vx -= fwdX * nowV;
        this.vz -= fwdZ * nowV;
      }
    }

    // Lateral grip: bleed off side-slip exponentially, which is framerate
    // independent by construction rather than by a fudge factor.
    latV = this.vx * rightX + this.vz * rightZ;
    const bleed = 1 - Math.exp(-t.grip * h);
    this.vx -= rightX * latV * bleed;
    this.vz -= rightZ * latV * bleed;

    // Re-read the frame-relative speeds after force integration so position, yaw
    // and the wheels all use the end-of-step velocity rather than a one-step lag.
    fwdV = this.vx * fwdX + this.vz * fwdZ;
    latV = this.vx * rightX + this.vz * rightZ;

    // Yaw. Steering geometry alone says omega = v * tan(delta) / L, which grows
    // without bound with speed: at 200 kph that is 127 g of lateral acceleration,
    // which no tyre can produce and no car can do. The tyres cap it — lateral
    // acceleration is limited to about mu*g, so the achievable yaw rate falls with
    // speed. That is not a hack: it is why a car understeers, and it is what keeps
    // a full-lock input from spinning the car at speed.
    const wheelbase = Math.max(0.5, t.halfBase * 2);
    const steerAngle = this.steer * t.maxSteer;
    const kinematic = (fwdV / wheelbase) * Math.tan(steerAngle) * t.yawFactor;
    const gripLimit = (t.maxLateralG * GRAVITY) / Math.max(1, Math.abs(fwdV));
    const targetYawRate = Math.sign(kinematic) * Math.min(Math.abs(kinematic), gripLimit);
    this.yawRate = damp(this.yawRate, targetYawRate, 6, h);
    this.yaw += this.yawRate * h;
    this.yawRate = damp(this.yawRate, 0, 1.4, h);

    this.x += (fwdX * fwdV + rightX * latV) * h;
    this.z += (fwdZ * fwdV + rightZ * latV) * h;

    this._bound();

    this._loadTransfer(aLong, fwdV, h);

    this.speed = fwdV;
    const kmh = Math.abs(fwdV) * 3.6;
    this.rpm = 850 + kmh * 320;
    this.gear = clamp(1 + Math.floor(kmh / 45), 1, 8);
    this.latG = (fwdV * this.yawRate) / GRAVITY;
    this.lonG = aLong / GRAVITY;

    this.wheelSpin += (fwdV / t.wheelRadius) * h;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.spin = this.wheelSpin;
      w.steer = i < 2 ? steerAngle : 0;
    }
  }

  /** Soft circular wall: push out of penetration, then reflect and absorb. */
  _bound() {
    const r = Math.hypot(this.x, this.z);
    if (r <= this.tuning.boundRadius || r === 0) return;
    const nx = this.x / r;
    const nz = this.z / r;
    const pen = r - this.tuning.boundRadius;
    this.x -= nx * pen;
    this.z -= nz * pen;
    const vn = this.vx * nx + this.vz * nz;
    if (vn > 0) {
      const k = (1 + this.tuning.boundRestitution) * vn;
      this.vx -= k * nx;
      this.vz -= k * nz;
      this.vx *= 0.86;
      this.vz *= 0.86;
      this.yawRate *= 0.5;
    }
  }

  /** Longitudinal and lateral acceleration into per-corner sag, then pitch/roll. */
  _loadTransfer(aLong, fwdV, h) {
    const aLat = fwdV * this.yawRate;
    const pitchIn = clamp(aLong * 0.014, -0.10, 0.10);
    const rollIn = clamp(aLat * 0.011, -0.09, 0.09);
    const sag = 0.10;
    const targets = [
      sag - rollIn - pitchIn,
      sag + rollIn - pitchIn,
      sag - rollIn + pitchIn,
      sag + rollIn + pitchIn
    ];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.sag = targets[i];
      w.sagSmooth = lerp(w.sagSmooth, w.sag, Math.min(1, h * 8));
    }

    const front = (this.wheels[0].sagSmooth + this.wheels[1].sagSmooth) / 2;
    const rear = (this.wheels[2].sagSmooth + this.wheels[3].sagSmooth) / 2;
    const left = (this.wheels[0].sagSmooth + this.wheels[2].sagSmooth) / 2;
    const rightW = (this.wheels[1].sagSmooth + this.wheels[3].sagSmooth) / 2;
    this.pitch = damp(this.pitch, (rear - front) * 0.42, 6, h);
    this.roll = damp(this.roll, (rightW - left) * 0.42, 6, h);
  }

  /** Telemetry for a HUD or the console. */
  get telemetry() {
    return {
      speedKph: Math.abs(this.speed) * 3.6,
      rpm: this.rpm,
      gear: this.gear,
      latG: this.latG,
      lonG: this.lonG,
      yawDeg: this.yaw * (180 / Math.PI)
    };
  }
}
