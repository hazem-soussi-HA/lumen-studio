/**
 * Component schemas.
 *
 * One declarative table drives three things: component defaults, the inspector
 * UI (fields, ranges, ordering, conditional visibility) and the serialiser. Adding
 * a renderer feature means adding a field here, not touching the editor code.
 *
 * Field types understood by the inspector: bool, number, slider, vec2, vec3,
 * angle, color, select, text, asset, layers, button, info, curve.
 */

export const FIELD = {
  BOOL: 'bool', NUMBER: 'number', SLIDER: 'slider', VEC2: 'vec2', VEC3: 'vec3',
  ANGLE: 'angle', COLOR: 'color', SELECT: 'select', TEXT: 'text', ASSET: 'asset',
  LAYERS: 'layers', BUTTON: 'button', INFO: 'info'
};

/**
 * Tone-curve selection, shared by the scene default, the inspector and the
 * composite shader (see `pcTonemap` in gl/shaders/common.js). Keeping the numbers
 * here is what stops the enum and the shader from drifting apart.
 */
export const TONE_MAP = { none: 0, reinhard: 1, filmic: 2, uncharted2: 3, linear: 4, aces: 5 };

export const LAYER_DEFS = [
  { id: 0, name: 'World' },
  { id: 1, name: 'Skybox' },
  { id: 2, name: 'UI' },
  { id: 3, name: 'Immediate' },
  { id: 4, name: 'Selection' },
  { id: 5, name: 'Gizmo' }
];

/* ------------------------------------------------------------- defaults -- */

export const createComponent = (type) => {
  switch (type) {
    case 'render':
      return {
        mesh: null,                 // asset id
        material: null,             // asset id
        castShadows: true,
        receiveShadows: true,
        layers: [0],
        visible: true,
        instanceCount: 0,           // >0 → instanced draw
        instanceSpread: 4,
        instanceLayout: 'grid'       // grid | ring | scatter
      };
    case 'camera':
      return {
        projection: 'perspective',  // perspective | orthographic
        fov: 50,
        orthoHeight: 5,
        near: 0.1,
        far: 1000,
        clearColor: [0.055, 0.06, 0.075, 1],
        clearColorMode: 'sky',      // sky | color | depth | none
        layers: [0, 1],
        priority: 0,
        frustumCulling: true,
        renderSceneColorMap: true,
        renderSceneDepthMap: true,
        toneMapping: TONE_MAP.ACES,
      };
    case 'light':
      return {
        type: 'directional',        // directional | omni | spot
        color: [1, 0.96, 0.9],
        intensity: 1,
        range: 10,
        innerConeAngle: 20,
        outerConeAngle: 35,
        castShadows: true,
        shadowBias: 0.2,
        shadowDistance: 60,
        shadowResolution: 2048,
        shadowUpdateMode: 'realtime', // realtime | thisframe | static
        enabled: true,
        affectSpecularity: true
      };
    case 'volume':
      return {
        asset: null,
        color: [0.7, 0.8, 1.0],
        density: 1.0,
        steps: 48,
        scrollSpeed: [0, 0, 0]
      };
    case 'script':
      return { order: [], enabled: true };
    case 'collision':
      return { type: 'box', halfExtents: [0.5, 0.5, 0.5], isTrigger: false };
    default:
      return {};
  }
};

/* --------------------------------------------------------------- schema -- */

export const COMPONENT_SCHEMA = {
  render: {
    label: 'Render',
    icon: '▣',
    order: 10,
    summary: (c) => (c.visible === false ? 'hidden' : `${c.castShadows ? 'shadows' : 'no shadows'}`),
    fields: [
      { path: 'mesh', label: 'Mesh', type: FIELD.ASSET, filter: 'model' },
      { path: 'material', label: 'Material', type: FIELD.ASSET, filter: 'material' },
      { path: 'visible', label: 'Enabled', type: FIELD.BOOL },
      { path: 'castShadows', label: 'Cast Shadows', type: FIELD.BOOL, when: (c) => c.visible !== false },
      { path: 'receiveShadows', label: 'Receive Shadows', type: FIELD.BOOL, when: (c) => c.visible !== false },
      { path: 'layers', label: 'Layers', type: FIELD.LAYERS },
      { path: 'instanceCount', label: 'Instances', type: FIELD.NUMBER, min: 0, max: 4096, step: 1, when: (c) => c.visible !== false, help: 'Draws the mesh N times with generated transforms through instanced rendering.' },
      { path: 'instanceSpread', label: 'Instance Spread', type: FIELD.NUMBER, min: 0, max: 50, step: 0.1, when: (c) => c.instanceCount > 1, help: 'Spacing of the generated instance transforms: grid pitch, ring radius or scatter radius.' },
      { path: 'instanceLayout', label: 'Layout', type: FIELD.SELECT, options: ['grid', 'ring', 'scatter'], when: (c) => c.instanceCount > 1, help: 'How the instance transforms are generated. Grid fills a square, ring places them on a circle, scatter uses a deterministic hash.' }
    ]
  },

  camera: {
    label: 'Camera',
    icon: '🎥',
    order: 20,
    summary: (c) => `${c.projection === 'perspective' ? `${Math.round(c.fov)}°` : 'ortho'} · near ${c.near} · far ${c.far}`,
    fields: [
      { path: 'projection', label: 'Projection', type: FIELD.SELECT, options: [['perspective', 'Perspective'], ['orthographic', 'Orthographic']] },
      { path: 'fov', label: 'Field of View', type: FIELD.ANGLE, min: 1, max: 179, step: 1, when: (c) => c.projection === 'perspective' },
      { path: 'orthoHeight', label: 'Ortho Height', type: FIELD.NUMBER, min: 0.1, max: 1000, step: 0.1, when: (c) => c.projection === 'orthographic' },
      { path: 'near', label: 'Near Clip', type: FIELD.NUMBER, min: 0.001, max: 100, step: 0.01, unit: 'm' },
      { path: 'far', label: 'Far Clip', type: FIELD.NUMBER, min: 1, max: 100000, step: 1, unit: 'm' },
      { path: 'clearColorMode', label: 'Clear', type: FIELD.SELECT, options: [['sky', 'Skybox'], ['color', 'Solid Colour'], ['depth', 'Depth Only'], ["none", 'Don\'t Clear']] },
      { path: 'clearColor', label: 'Clear Colour', type: FIELD.COLOR, when: (c) => c.clearColorMode === 'color' },
      { path: 'layers', label: 'Layers', type: FIELD.LAYERS },
      { path: 'priority', label: 'Priority', type: FIELD.NUMBER, min: 0, max: 127, step: 1, help: 'Cameras render in ascending priority order.' },
      { path: 'frustumCulling', label: 'Frustum Culling', type: FIELD.BOOL },
      { path: 'toneMapping', label: 'Tone Mapping', type: FIELD.SELECT, options: [['inherit', 'Inherit'], ['none', 'None'], ['linear', 'Linear'], ['reinhard', 'Reinhard'], ['filmic', 'Filmic'], ['uncharted2', 'Uncharted 2'], ['aces', 'ACES']], serialize: (v) => (v === 'inherit' ? TONE_MAP.ACES : TONE_MAP[v]) },
      { path: 'renderSceneColorMap', label: 'Render Colour', type: FIELD.BOOL },
      { path: 'renderSceneDepthMap', label: 'Render Depth', type: FIELD.BOOL }
    ]
  },

  light: {
    label: 'Light',
    icon: '☀',
    order: 30,
    summary: (c) => `${c.type} · ${c.intensity.toFixed(2)}`,
    fields: [
      { path: 'type', label: 'Type', type: FIELD.SELECT, options: [['directional', 'Directional'], ['omni', 'Omni'], ['spot', 'Spot']] },
      { path: 'color', label: 'Colour', type: FIELD.COLOR },
      { path: 'intensity', label: 'Intensity', type: FIELD.NUMBER, min: 0, max: 50, step: 0.01 },
      { path: 'range', label: 'Range', type: FIELD.NUMBER, min: 0.1, max: 1000, step: 0.1, unit: 'm', when: (c) => c.type !== 'directional' },
      { path: 'innerConeAngle', label: 'Inner Cone', type: FIELD.ANGLE, min: 0, max: 89, step: 0.5, unit: '°', when: (c) => c.type === 'spot' },
      { path: 'outerConeAngle', label: 'Outer Cone', type: FIELD.ANGLE, min: 0.1, max: 90, step: 0.5, unit: '°', when: (c) => c.type === 'spot' },
      { path: 'affectSpecularity', label: 'Specular', type: FIELD.BOOL },
      { path: 'castShadows', label: 'Cast Shadows', type: FIELD.BOOL, when: (c) => c.type !== 'omni' },
      { path: 'shadowResolution', label: 'Shadow Map', type: FIELD.SELECT, options: [[512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096']], when: (c) => c.castShadows },
      { path: 'shadowDistance', label: 'Shadow Distance', type: FIELD.NUMBER, min: 1, max: 500, step: 1, unit: 'm', when: (c) => c.castShadows && c.type === 'directional' },
      { path: 'shadowBias', label: 'Shadow Bias', type: FIELD.NUMBER, min: 0, max: 1, step: 0.01, when: (c) => c.castShadows },
      { path: 'shadowUpdateMode', label: 'Shadow Update', type: FIELD.SELECT, options: [['realtime', 'Realtime'], ['thisframe', 'This Frame'], ['static', 'Static']], when: (c) => c.castShadows },
      { path: 'enabled', label: 'Enabled', type: FIELD.BOOL }
    ]
  },

  volume: {
    label: 'Volume',
    icon: '☁',
    order: 40,
    summary: (c) => `density ${Number(c.density).toFixed(2)}`,
    fields: [
      { path: 'asset', label: 'Volume', type: FIELD.ASSET, filter: 'volume' },
      { path: 'color', label: 'Colour', type: FIELD.COLOR },
      { path: 'density', label: 'Density', type: FIELD.SLIDER, min: 0, max: 8, step: 0.01 },
      { path: 'steps', label: 'Ray Steps', type: FIELD.NUMBER, min: 8, max: 96, step: 1, help: 'Quality/cost trade-off for the ray-march.' },
      { path: 'scrollSpeed', label: 'Scroll Speed', type: FIELD.VEC3 }
    ]
  },

  collision: {
    label: 'Collision',
    icon: '◈',
    order: 50,
    summary: (c) => c.type,
    fields: [
      { path: 'type', label: 'Shape', type: FIELD.SELECT, options: [['box', 'Box'], ['sphere', 'Sphere']] },
      { path: 'halfExtents', label: 'Half Extents', type: FIELD.VEC3, when: (c) => c.type === 'box' },
      { path: 'isTrigger', label: 'Is Trigger', type: FIELD.BOOL }
    ]
  },

  script: {
    label: 'Script', icon: '⌘', order: 90,
    summary: (c) => `${c.order.length} script(s)`,
    fields: [
      { path: 'enabled', label: 'Enabled', type: FIELD.BOOL },
      { path: 'order', label: 'Scripts', type: FIELD.TEXT, readonly: true }
    ]
  }
};

/** Entity-level fields shown above the component accordions. */
export const ENTITY_SCHEMA = {
  name: { label: 'Name', type: FIELD.TEXT },
  tags: { label: 'Tags', type: FIELD.TEXT, placeholder: 'comma,separated' },
  enabled: { label: 'Enabled', type: FIELD.BOOL }
};

export const componentOrder = (type) => COMPONENT_SCHEMA[type]?.order ?? 100;

export function defaultTags(type) {
  return { render: ['Render'], camera: ['Camera'], light: ['Light'], volume: ['Volume'] }[type] || [];
}

/** Fill in any missing keys so older projects keep loading after a schema change. */
export function migrateComponent(type, data) {
  const base = createComponent(type);
  const out = { ...base, ...(data || {}) };
  // Nested objects (light.shadow, camera.rect, …) are merged one level deep.
  for (const k in base) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && out[k] && typeof out[k] === 'object') {
      out[k] = { ...base[k], ...out[k] };
    }
  }
  return out;
}
