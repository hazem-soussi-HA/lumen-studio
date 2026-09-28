/**
 * Inspector — schema-driven property editor.
 *
 * The panel is generated from COMPONENT_SCHEMA: an entity shows its metadata
 * (name, tags, id, type, size — the same information PlayCanvas surfaces) plus one
 * accordion per component, with conditional fields, drag-scrub numerics, colour
 * pickers, asset references and layer chips.
 *
 * Selecting a material asset switches the inspector into "material" mode, so the
 * same panel edits both objects without a second UI.
 */

import { h, NumberField, Vec3Field, ColorField, BoolField, SelectField, TextField, LayersField, AssetRefField, InfoField, ButtonRow, formatNumber } from './widgets.js';
import { COMPONENT_SCHEMA, ENTITY_SCHEMA, LAYER_DEFS, createComponent, defaultTags, migrateComponent } from '../scene/components.js';
import { formatBytes } from '../core/utils.js';
import { BLEND, CULL, MATERIAL_PRESETS } from '../scene/material.js';
import { depthFormat, hdrFormat } from '../gl/texture.js';

export class Inspector {
  constructor(app, root, titleEl) {
    this.app = app;
    this.root = root;
    this.titleEl = titleEl;
    this.fields = [];
    this.collapsed = new Set();
    this.mode = 'entity';
    this.entity = null;
    this.asset = null;
    this._updating = false;
  }

  /* --------------------------------------------------------------- render */

  render() {
    const scroll = this.root.scrollTop;
    this.root.textContent = '';
    this.fields = [];

    if (this.mode === 'asset') this._renderAsset();
    else this._renderEntities();

    this.root.scrollTop = scroll;
  }

  showEntity(entity) {
    this.mode = 'entity';
    this.entity = entity;
    this.asset = null;
    this.render();
  }

  showAsset(asset) {
    this.mode = 'asset';
    this.asset = asset;
    this.entity = null;
    this.render();
  }

  showEmpty() {
    this.mode = 'none';
    this.entity = null;
    this.render();
  }

  /** Cheap path: only rewrite values, used during gizmo drags. */
  update() {
    if (this.mode === 'entity' && this.entity) this._updateValues(this.entity);
    if (this.mode === 'asset' && this.asset) this._updateAssetValues(this.asset);
  }

  _updateValues(entity) {
    if (this._updating) return;
    this._updating = true;
    for (const f of this.fields) f.refresh();
    this._updating = false;
  }

  _updateAssetValues(asset) {
    if (this._updating) return;
    this._updating = true;
    for (const f of this.fields) f.refresh();
    this._updating = false;
  }

  /* -------------------------------------------------------------- entity */

  _renderEntities() {
    const sel = this.app.scene.selection;
    if (!sel.length) {
      this.titleEl.textContent = 'Inspector';
      this.root.appendChild(this._empty('No selection', 'Pick an entity in the hierarchy or click an object in the viewport.'));
      this.root.appendChild(this._sceneSection());
      return;
    }
    if (sel.length > 1) {
      this.titleEl.textContent = `${sel.length} entities`;
      this.root.appendChild(this._empty('Multiple selection', 'Transform edits apply to all selected entities.'));
      for (const f of this._transformFields(sel)) this.root.appendChild(f.el);
      return;
    }

    const e = sel[0];
    this.titleEl.textContent = 'Inspector';
    this.root.appendChild(this._entitySection(e));
    this.root.appendChild(this._transformSection(e));

    const types = Object.keys(e.components).sort((a, b) => (COMPONENT_SCHEMA[a]?.order ?? 100) - (COMPONENT_SCHEMA[b]?.order ?? 100));
    for (const type of types) this.root.appendChild(this._componentSection(e, type));
    this.root.appendChild(this._addComponentSection(e));
  }

  _empty(title, text) {
    return h('div', { class: 'insp-empty' }, [h('strong', { text: title }), h('p', { text })]);
  }

  _accordion(key, title, summary, build) {
    const open = !this.collapsed.has(key);
    const head = h('button', {
      class: `acc-head${open ? ' is-open' : ''}`,
      type: 'button',
      onclick: () => {
        if (this.collapsed.has(key)) this.collapsed.delete(key);
        else this.collapsed.add(key);
        this.render();
      }
    }, [
      h('span', { class: 'acc-chev', text: '▸' }),
      h('span', { class: 'acc-title', text: title }),
      h('span', { class: 'acc-summary', text: summary || '' })
    ]);
    const body = h('div', { class: 'acc-body' });
    if (open) build(body);
    return h('div', { class: `accordion${open ? ' is-open' : ''}` }, [head, open ? body : null]);
  }

  _entitySection(e) {
    const nameField = new TextField({
      label: ENTITY_SCHEMA.name.label,
      value: e.name,
      onChange: (v, meta) => {
        e.name = v;
        this.app.hierarchy?.render();
        this.app.markDirty(`Rename to "${v}"`, { coalesce: `name-${e.id}`, live: meta.live, skipIfSame: false });
      }
    });
    const tagsField = new TextField({
      label: ENTITY_SCHEMA.tags.label,
      value: e.tags.join(', '),
      placeholder: 'comma,separated',
      onChange: (v) => {
        e.tags = v.split(',').map((t) => t.trim()).filter(Boolean);
        this.app.hierarchy?.render();
        this.app.markDirty('Edit tags');
      }
    });
    const enabled = new BoolField({
      label: ENTITY_SCHEMA.enabled.label,
      value: e.enabled,
      onChange: (v) => {
        e.enabled = v;
        this.app.hierarchy?.render();
        this.app.markDirty(`${v ? 'Enable' : 'Disable'} ${e.name}`);
        this.app.requestRender();
      }
    });
    this.fields.push(nameField, tagsField, enabled);

    const size = this._entitySize(e);
    return this._accordion(`entity:${e.id}`, 'Entity', e.name, (body) => {
      body.append(nameField.el, tagsField.el, enabled.el);
      body.appendChild(h('div', { class: 'kv' }, [
        this._kv('ID', e.id),
        this._kv('Type', primaryType(e)),
        this._kv('Layers', (e.components.render?.layers || [0]).join(', ')),
        this._kv('Size', size),
        this._kv('Children', String(e.children.length))
      ]));
    });
  }

  _entitySize(e) {
    let bytes = 0;
    const render = e.components.render;
    if (render) {
      const mesh = this.app.assets.get(render.mesh)?.gpu;
      if (mesh) bytes += mesh.vertexBuffer.byteLength + (mesh.indices?.buffer?.byteLength || 0);
    }
    return formatBytes(bytes);
  }

  _kv(k, v) {
    return h('div', { class: 'kv-row' }, [h('span', { class: 'kv-k', text: k }), h('span', { class: 'kv-v', text: v })]);
  }

  _transformSection(e) {
    const pos = new Vec3Field({
      label: 'Position', value: [...e.position], step: 0.01, unit: 'm',
      onChange: (v, meta) => {
        e.position = v;
        this.app.markDirty('Move', { coalesce: `move-${e.id}`, live: meta.live });
        this.app.requestRender();
      }
    });
    const rot = new Vec3Field({
      label: 'Rotation', value: e.euler, step: 0.5, unit: '°', min: -Infinity, max: Infinity,
      onChange: (v, meta) => {
        e.euler = v;
        this.app.markDirty('Rotate', { coalesce: `rot-${e.id}`, live: meta.live });
        this.app.requestRender();
      }
    });
    const scl = new Vec3Field({
      label: 'Scale', value: [...e.scale], step: 0.01, min: -Infinity, max: Infinity,
      onChange: (v, meta) => {
        e.scale = v;
        this.app.markDirty('Scale', { coalesce: `scale-${e.id}`, live: meta.live });
        this.app.requestRender();
      }
    });
    this.fields.push(pos, rot, scl);
    const s = e.scale;
    const uniform = Math.abs(s[0] - s[1]) < 1e-4 && Math.abs(s[1] - s[2]) < 1e-4;
    return this._accordion(`transform:${e.id}`, 'Transform', `${formatNumber(s[0], 2)} · ${e.euler.map((v) => Math.round(v)).join('/')}`, (body) => {
      body.append(pos.el, rot.el, scl.el);
      body.appendChild(new ButtonRow({
        label: '',
        buttons: [
          { label: 'Reset', title: 'Reset transform', onClick: () => { e.position = [0, 0, 0]; e.euler = [0, 0, 0]; e.scale = [1, 1, 1]; this.app.markDirty('Reset transform'); this.render(); this.app.requestRender(); } },
          { label: 'Uniform', title: 'Make the scale uniform', onClick: () => { const m = (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2])) / 3; e.scale = [m, m, m]; this.app.markDirty('Uniform scale'); this.render(); this.app.requestRender(); } },
          { label: 'Centre', title: 'Move the pivot to the geometry origin', onClick: () => this._centrePivot(e) }
        ]
      }).el);
      void uniform;
    });
  }

  _centrePivot(e) {
    const b = e.worldAABB;
    if (b.min[0] === Infinity) return;
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    e.setWorldPosition(c[0], c[1], c[2]);
    this.app.markDirty('Centre pivot');
    this.app.requestRender();
  }

  _componentSection(e, type) {
    const schema = COMPONENT_SCHEMA[type];
    if (!schema) return h('div');
    const data = e.components[type];
    const fields = this._buildFields(e, type, data, schema);
    return this._accordion(`comp:${e.id}:${type}`, schema.label, schema.summary?.(data) || '', (body) => {
      for (const f of fields) body.appendChild(f.el);
      body.appendChild(h('div', { class: 'acc-actions' }, [
        h('button', {
          class: 'btn btn-ghost', type: 'button', text: 'Remove Component',
          onclick: () => {
            e.removeComponent(type);
            this.app.markDirty(`Remove ${schema.label} from ${e.name}`);
            this.app.hierarchy?.render();
            this.render();
            this.app.requestRender();
          }
        })
      ]));
    });
  }

  _addComponentSection(e) {
    return this._accordion(`add:${e.id}`, 'Add Component', '', (body) => {
      const grid = h('div', { class: 'comp-grid' });
      for (const [type, schema] of Object.entries(COMPONENT_SCHEMA)) {
        if (e.hasComponent(type)) continue;
        grid.appendChild(h('button', {
          class: 'comp-btn', type: 'button',
          onclick: () => {
            const data = createComponent(type);
            if (type === 'light') data.tags = defaultTags(type);
            e.addComponent(type, data);
            if (type === 'render') {
              const mesh = this.app.assets.byType('model')[0];
              const mat = this.app.assets.byType('material')[0];
              data.mesh = mesh?.id || null;
              data.material = mat?.id || null;
            }
            this.app.markDirty(`Add ${schema.label}`);
            this.app.hierarchy?.render();
            this.render();
            this.app.requestRender();
          }
        }, [h('span', { class: 'comp-icon', text: schema.icon || '◇' }), h('span', { text: schema.label })]));
      }
      body.appendChild(grid);
    });
  }

  /* -------------------------------------------------------------- fields */

  _buildFields(entity, type, data, schema) {
    const out = [];
    for (const def of schema.fields) {
      if (def.when && !def.when(data, entity)) continue;
      const get = () => getPath(entity, type, def.path);
      const set = (v, meta) => {
        setPath(entity, type, def.path, v);
        this.app.markDirty(`${def.label}`, { coalesce: `${type}.${def.path}-${entity.id}`, live: meta?.live });
        this.app.requestRender();
      };
      // `getValue` lets `refresh()` re-read the model — a gizmo drag changes the
      // entity underneath the widget, and the widget has to follow it.
      const common = { label: def.label, hint: def.help, min: def.min, max: def.max, step: def.step, unit: def.unit, precision: def.precision, getValue: get };
      let field;
      switch (def.type) {
        case 'bool': field = new BoolField({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'number': field = new NumberField({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'slider': field = new NumberField({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'vec2': field = new Vec3Field({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'vec3': field = new Vec3Field({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'angle': field = new NumberField({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'color': field = new ColorField({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'select': field = new SelectField({ ...common, options: def.options, value: get(), onChange: (v, meta) => set(def.serialize ? def.serialize(v) : v, meta) }); break;
        case 'text': field = new TextField({ ...common, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'layers': field = new LayersField({ ...common, layers: LAYER_DEFS, value: get(), onChange: (v, meta) => set(v, meta) }); break;
        case 'asset': field = new AssetRefField({
          ...common, value: get(), store: this.app.assets, filter: def.filter,
          onChange: (v, meta) => set(v, meta),
          onPick: (f) => this.app.pickAsset(def.filter, (id) => { f.value = id; f.setValue(); set(id, { final: true }); })
        }); break;
        case 'info': field = new InfoField({ ...common, text: def.text }); break;
        default: field = new InfoField({ ...common, text: '—' });
      }
      this.fields.push(field);
      out.push(field);
    }
    return out;
  }

  /* --------------------------------------------------------------- asset */

  _renderAsset() {
    const asset = this.asset;
    if (!asset) return this.showEmpty();
    this.titleEl.textContent = asset.type === 'material' ? 'Material' : 'Asset';
    if (asset.type === 'material') return this._renderMaterial(asset);
    if (asset.type === 'texture') return this._renderTexture(asset);
    if (asset.type === 'model') return this._renderModel(asset);
    if (asset.type === 'volume') return this._renderVolume(asset);
    return this.root;
  }

  _renderMaterial(asset) {
    const m = asset.material;
    const set = (key) => (v, meta) => {
      m[key] = v;
      m.touch();
      this.app.markDirty(`${asset.name}: ${key}`, { coalesce: `mat-${asset.id}-${key}`, live: meta?.live });
      this.app.assets.emit('change', 'asset', asset.id);
      this.app.requestRender();
    };
    const num = (label, key, extra = {}) => new NumberField({ label, value: m[key], onChange: set(key), ...extra });
    const fields = [
      new TextField({ label: 'Name', value: m.name, onChange: (v) => { m.name = v; asset.name = v; this.app.assets.rename(asset.id, v); this.app.assetsPanel?.render(); this.app.markDirty('Rename material'); } }),
      new ColorField({ label: 'Diffuse', value: [...m.diffuse], onChange: (v, meta) => { m.diffuse = v; set('diffuse')(v, meta); } }),
      num('Metalness', 'metalness', { min: 0, max: 1, step: 0.01 }),
      num('Roughness', 'roughness', { min: 0, max: 1, step: 0.01 }),
      num('Specular', 'specular', { min: 0, max: 2, step: 0.01 }),
      new ColorField({ label: 'Emissive', value: [...m.emissive], onChange: (v, meta) => { m.emissive = v; set('emissive')(v, meta); } }),
      num('Emissive Intensity', 'emissiveIntensity', { min: 0, max: 40, step: 0.05 }),
      num('Opacity', 'opacity', { min: 0, max: 1, step: 0.01 }),
      new SelectField({
        label: 'Blend', value: m.blend, options: [
          [BLEND.NONE, 'Opaque'], [BLEND.NORMAL, 'Normal'], [BLEND.PREMULTIPLIED, 'Premultiplied'],
          [BLEND.ADDITIVE, 'Additive'], [BLEND.MULTIPLY, 'Multiply']
        ], onChange: set('blend')
      }),
      num('Alpha Test', 'alphaTest', { min: 0, max: 1, step: 0.01 }),
      new SelectField({
        label: 'Cull', value: m.cull, options: [[CULL.BACK, 'Back'], [CULL.FRONT, 'Front'], [CULL.NONE, 'None']],
        onChange: set('cull')
      }),
      new BoolField({ label: 'Two-Sided Lighting', value: m.twoSidedLighting, onChange: set('twoSidedLighting') }),
      new BoolField({ label: 'Depth Write', value: m.depthWrite, onChange: set('depthWrite') }),
      new BoolField({ label: 'Vertex Colours', value: m.vertexColors, onChange: set('vertexColors') }),
      new Vec3Field({ label: 'Tiling (XY)', value: [...m.tiling], min: 0.001, step: 0.05, onChange: set('tiling') }),
      new Vec3Field({ label: 'Offset (XY)', value: [...m.offset], step: 0.01, onChange: set('offset') }),
      num('UV Rotation', 'rotation', { min: 0, max: 360, step: 1, unit: '°' }),
      num('Bumpiness', 'bumpiness', { min: 0, max: 4, step: 0.01 }),
      this._assetRefField(asset, 'Diffuse Map', 'diffuseMap', 'texture'),
      this._assetRefField(asset, 'Normal Map', 'normalMap', 'texture'),
      this._assetRefField(asset, 'Metal/Rough Map', 'metalRoughMap', 'texture'),
      this._assetRefField(asset, 'Occlusion Map', 'occlusionMap', 'texture'),
      this._assetRefField(asset, 'Emissive Map', 'emissiveMap', 'texture')
    ];
    this.fields.push(...fields);

    this.root.appendChild(this._materialPreview(asset));
    this.root.appendChild(this._accordion(`mat:${asset.id}`, 'Material', m.name, (body) => {
      for (const f of fields) body.appendChild(f.el);
      body.appendChild(new ButtonRow({
        label: 'Presets',
        buttons: MATERIAL_PRESETS.slice(0, 6).map((p) => ({
          label: p.name.split(' ')[0], title: p.name,
          onClick: () => {
            Object.assign(m, p.data);
            m.touch();
            this.app.markDirty(`Apply preset ${p.name}`);
            this.render();
            this.app.requestRender();
          }
        }))
      }).el);
    }));
    this.root.appendChild(this._sceneSection());
  }

  _materialPreview(asset) {
    const canvas = h('canvas', { class: 'mat-preview', width: 220, height: 130 });
    this.root.appendChild(canvas);
    requestAnimationFrame(() => {
      try { this.app.renderer.renderMaterialPreview(asset.material, canvas, { size: 256 }); } catch (e) {
        this.app.log.warn('material preview failed:', e.message);
      }
    });
    return canvas;
  }

  _assetRefField(asset, label, key, filter) {
    return new AssetRefField({
      label, value: asset.material[key], store: this.app.assets,
      onChange: (v, meta) => {
        asset.material[key] = v;
        asset.material.touch();
        this.app.markDirty(`${asset.name}: ${label}`, { live: meta?.live });
        this.app.requestRender();
      },
      onPick: (f) => this.app.pickAsset(filter, (id) => { f.value = id; f.setValue(); f.onChange(id, { final: true }); })
    });
  }

  _renderTexture(asset) {
    const rows = [
      this._kv('Size', `${asset.width || asset.size} × ${asset.height || asset.size}`),
      this._kv('Format', 'RGBA8'),
      this._kv('Colour space', asset.srgb === false ? 'Linear (data)' : 'sRGB'),
      this._kv('Wrap', asset.wrap || 'repeat'),
      this._kv('Mipmaps', 'generated'),
      this._kv('Anisotropy', `${Math.min(8, this.app.ctx.caps.limits.maxAnisotropy)}×`),
      this._kv('Kind', asset.kind || 'image')
    ];
    this.root.appendChild(this._accordion(`tex:${asset.id}`, 'Texture', asset.name, (body) => {
      body.appendChild(h('div', { class: 'kv' }, rows));
    }));
    this.root.appendChild(this._sceneSection());
  }

  _renderModel(asset) {
    const mesh = asset.gpu;
    const rows = [
      this._kv('Vertices', mesh ? String(mesh.vertexCount) : '—'),
      this._kv('Triangles', mesh ? String(mesh.triangleCount) : '—'),
      this._kv('Index format', mesh?.indices ? (mesh.indices.type === this.app.ctx.gl.UNSIGNED_INT ? 'uint32' : 'uint16') : '—'),
      this._kv('Bounds', mesh ? `${mesh.aabb.min.map((v) => v.toFixed(2)).join(', ')} → ${mesh.aabb.max.map((v) => v.toFixed(2)).join(', ')}` : '—'),
      this._kv('GPU memory', mesh ? formatBytes(mesh.vertexBuffer.byteLength) : '—')
    ];
    this.root.appendChild(this._accordion(`mdl:${asset.id}`, 'Model', asset.name, (body) => {
      body.appendChild(h('div', { class: 'kv' }, rows));
      body.appendChild(new ButtonRow({
        label: '',
        buttons: [{
          label: 'Create Entity', onClick: () => this.app.addEntityWithMesh(asset.id, asset.name)
        }]
      }).el);
    }));
    this.root.appendChild(this._sceneSection());
  }

  _renderVolume(asset) {
    const rows = [
      this._kv('Resolution', `${asset.size}³`),
      this._kv('Storage', asset.emulated ? '2D tile atlas (WebGL 1 has no sampler3D)' : 'TEXTURE_3D'),
      this._kv('Slices', asset.tiles ? `${asset.tiles}×${asset.tiles} tiles` : '—'),
      this._kv('Memory', formatBytes(asset.bytes || 0))
    ];
    this.root.appendChild(this._accordion(`vol:${asset.id}`, 'Volume', asset.name, (body) => {
      body.appendChild(h('div', { class: 'kv' }, rows));
    }));
    this.root.appendChild(this._sceneSection());
  }

  /* -------------------------------------------------------- scene section */

  _sceneSection() {
    const app = this.app;
    const s = app.scene.settings;
    const r = s.render;
    const num = (label, obj, key, extra = {}) => new NumberField({
      label, value: obj[key], ...extra,
      onChange: (v, meta) => {
        obj[key] = v;
        app.applySceneSettings();
        app.markDirty(`Scene: ${label}`, { coalesce: `scene-${key}`, live: meta?.live });
        app.requestRender();
      }
    });
    const bool = (label, obj, key) => new BoolField({
      label, value: obj[key],
      onChange: (v) => {
        obj[key] = v;
        app.applySceneSettings();
        app.markDirty(`Scene: ${label}`);
        app.requestRender();
      }
    });
    const fields = [
      num('Exposure', r, 'exposure', { min: 0.05, max: 8, step: 0.01 }),
      new SelectField({
        label: 'Tone Mapping', value: String(r.toneMapping),
        options: [['0', 'ACES'], ['1', 'Reinhard'], ['2', 'Filmic'], ['3', 'Uncharted 2'], ['4', 'None']],
        onChange: (v) => { r.toneMapping = Number(v); app.applySceneSettings(); app.markDirty('Scene: tone mapping'); app.requestRender(); }
      }),
      bool('Bloom', r, 'bloom'),
      num('Bloom Strength', r, 'bloomStrength', { min: 0, max: 1, step: 0.005 }),
      bool('SSAO', r, 'ssao'),
      bool('FXAA', r, 'fxaa'),
      bool('Fog', r, 'fog'),
      new ColorField({
        label: 'Fog Colour', value: [...r.fogColor, 1],
        onChange: (v) => { r.fogColor = [v[0], v[1], v[2]]; app.applySceneSettings(); app.markDirty('Scene: fog colour'); app.requestRender(); }
      }),
      num('Fog Density', r, 'fogDensity', { min: 0, max: 0.2, step: 0.0005 }),
      new ColorField({
        label: 'Ambient', value: [...r.ambient, 1],
        onChange: (v) => { r.ambient = [v[0], v[1], v[2]]; app.applySceneSettings(); app.markDirty('Scene: ambient'); app.requestRender(); }
      }),
      num('Ambient Intensity', r, 'ambientIntensity', { min: 0, max: 8, step: 0.01 }),
      bool('Grid', r, 'grid'),
      num('Grid Cell', r, 'gridCell', { min: 0.05, max: 100, step: 0.05, unit: 'm' })
    ];
    this.fields.push(...fields);

    const sky = s.sky;
    const skyNum = (label, key, extra = {}) => new NumberField({
      label, value: sky[key], ...extra,
      onChange: (v, meta) => {
        sky[key] = v;
        app.applySceneSettings();
        app.markDirty(`Sky: ${label}`, { coalesce: `sky-${key}`, live: meta?.live });
        app.requestRender();
      }
    });
    const skyColor = (label, key) => new ColorField({
      label, value: [...sky[key], 1],
      onChange: (v, meta) => {
        sky[key] = [v[0], v[1], v[2]];
        app.applySceneSettings();
        app.markDirty(`Sky: ${label}`, { live: meta?.live });
        app.requestRender();
      }
    });
    const skyFields = [
      skyColor('Zenith', 'zenith'), skyColor('Horizon', 'horizon'), skyColor('Ground', 'ground'),
      skyNum('Sun Intensity', 'sunIntensity', { min: 0, max: 60, step: 0.1 }),
      skyNum('Turbidity', 'turbidity', { min: 0.2, max: 8, step: 0.05 }),
      skyNum('Exposure', 'exposure', { min: 0.1, max: 4, step: 0.01 }),
      skyNum('IBL Intensity', 'iblIntensity', { min: 0, max: 4, step: 0.01 }),
      skyNum('Background', 'backgroundIntensity', { min: 0, max: 4, step: 0.01 })
    ];
    this.fields.push(...skyFields);

    const renderAcc = this._accordion('scene', 'Scene', app.scene.name, (body) => {
      for (const f of fields) body.appendChild(f.el);
      body.appendChild(new ButtonRow({
        label: '',
        buttons: [
          { label: 'Noon', title: 'Midday sky', onClick: () => app.setSkyPreset('noon') },
          { label: 'Sunset', title: 'Golden hour', onClick: () => app.setSkyPreset('sunset') },
          { label: 'Overcast', title: 'Studio overcast', onClick: () => app.setSkyPreset('overcast') },
          { label: 'Night', title: 'Night', onClick: () => app.setSkyPreset('night') }
        ]
      }).el);
    });
    const skyAcc = this._accordion('sky', 'Sky & IBL', `${Math.round(sky.sunIntensity)} sun`, (body) => {
      for (const f of skyFields) body.appendChild(f.el);
      body.appendChild(h('div', { class: 'kv' }, [
        this._kv('Radiance cube', `${this.app.renderer.ibl.stats.radianceSize || 128}px · 6 mips`),
        this._kv('Irradiance', 'SH-9 (CPU)'),
        this._kv('Prefiltered', `${this.app.renderer.ibl.prefilteredMips} roughness steps`),
        this._kv('BRDF LUT', this.app.renderer.ibl.isEmulated ? 'analytic fallback' : '128×128'),
        this._kv('Last build', `${(this.app.renderer.ibl.stats.lastBuildMs || 0).toFixed(1)} ms`)
      ]));
    });
    return h('div', { class: 'acc-group' }, [renderAcc, skyAcc]);
  }
}

/* ---------------------------------------------------------------- utils -- */

function getPath(entity, type, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), entity.components[type]);
}

function setPath(entity, type, path, value) {
  const keys = path.split('.');
  let o = entity.components[type];
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] === undefined || o[keys[i]] === null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function primaryType(e) {
  const keys = Object.keys(e.components);
  if (!keys.length) return 'entity';
  return keys.sort((a, b) => (COMPONENT_SCHEMA[a]?.order ?? 100) - (COMPONENT_SCHEMA[b]?.order ?? 100))[0];
}

export { migrateComponent, hdrFormat, depthFormat };
