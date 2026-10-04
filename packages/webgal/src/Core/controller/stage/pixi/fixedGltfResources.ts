type Component = Record<string, any>;
export interface FixedResourceEntry {
  type: string; name: string; config: string; component: Component;
  motionGroup?: string; basePath: string;
}

export class ResourceHttpError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`${status} ${url}`);
  }
}

/** Fixed WebGAL paths and shared bytes for preparation and playback. */
export class FixedGltfResources {
  readonly indexUrl: string;
  readonly root: string;
  entries: FixedResourceEntry[] = [];
  private pending = new Map<string, Promise<ArrayBuffer>>();
  private bytes = new Map<string, ArrayBuffer>();
  private cachedBytes = 0;
  private loaded?: Promise<this>;

  constructor(base: string, private readonly request: typeof fetch = fetch) {
    this.root = new URL('./game/3d/', base).href;
    this.indexUrl = new URL('runtime/index.json', this.root).href;
  }

  private async buffer(url: string): Promise<ArrayBuffer> {
    const cached = this.bytes.get(url);
    if (cached) { this.bytes.delete(url); this.bytes.set(url, cached); return cached; }
    let pending = this.pending.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await this.request.call(globalThis, url);
        if (!response.ok) throw new ResourceHttpError(response.status, url);
        const value = await response.arrayBuffer();
        if (value.byteLength <= 64 * 1024 * 1024) {
          while (this.bytes.size && (this.bytes.size >= 256 || this.cachedBytes + value.byteLength > 64 * 1024 * 1024)) {
            const oldest = this.bytes.keys().next().value as string;
            this.cachedBytes -= this.bytes.get(oldest)!.byteLength; this.bytes.delete(oldest);
          }
          this.bytes.set(url, value); this.cachedBytes += value.byteLength;
        }
        return value;
      })();
      this.pending.set(url, pending);
      void pending.finally(() => { if (this.pending.get(url) === pending) this.pending.delete(url); }).catch(() => {});
    }
    return pending;
  }

  async fetch(url: string, kind = 'json'): Promise<any> {
    const bytes = await this.buffer(url);
    return kind === 'bytes' ? bytes : JSON.parse(new TextDecoder().decode(bytes));
  }
  async response(url: string) { return new Response(await this.buffer(url)); }

  load(): Promise<this> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const index = await this.fetch(this.indexUrl);
        if (!Array.isArray(index.packages)) throw Error(`${this.indexUrl}: packages must be an array`);
        const entries: FixedResourceEntry[] = [];
        const identities = new Set<string>();
        for (const path of index.packages) {
          if (typeof path !== 'string' || !path || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(path)
              || path.replaceAll('\\', '/').split('/').includes('..')) throw Error(`${this.indexUrl}: invalid package path`);
          const config = new URL(path, this.indexUrl).href;
          const manifest = await this.fetch(config);
          if (!Array.isArray(manifest.components)) throw Error(`${config}: components must be an array`);
          for (const component of manifest.components) {
            const name = component.type === 'behavior' ? `${component.namespace}.${component.name}` : component.name;
            const key = `${component.type}:${name}`;
            if (identities.has(key)) throw Error(`${config}: duplicate ${key}`);
            identities.add(key);
            entries.push({ type: component.type, name, config, component,
              motionGroup: component.motionGroup, basePath: new URL('.', config).href });
          }
        }
        this.entries = entries;
        return this;
      })();
      void this.loaded.catch(() => { this.loaded = undefined; });
    }
    return this.loaded;
  }

  find(type: string, name: string) { return this.entries.find(entry => entry.type === type && entry.name === name); }
  async resolve(entry?: FixedResourceEntry) {
    if (!entry) throw Error('Runtime resource not found');
    return entry;
  }
  async model(config: string) {
    const manifest = await this.fetch(config);
    const models = manifest.components?.filter((c: Component) => c.type === 'model') ?? [];
    if (models.length !== 1 || models[0].role !== 'integrated') throw Error(`${config}: expected one integrated model`);
    return { type: 'model', name: models[0].name, component: models[0], config, basePath: new URL('.', config).href };
  }

  async resolveMotion(name: string, { optional = false } = {}): Promise<FixedResourceEntry | null> {
    const binary = name.endsWith('.motionbin');
    let url = new URL(binary ? `motion/${name}` : `mtn_exp/${name}.mtn`, this.root).href;
    let type = binary ? 'motion' : 'garupa-motion';
    try { await this.buffer(url); }
    catch (error) {
      if (!(error instanceof ResourceHttpError) || error.status !== 404) throw error;
      if (!binary) {
        url = new URL(`motion/${name}.motionbin`, this.root).href; type = 'motion';
        try { await this.buffer(url); }
        catch (fallback) { if (optional && fallback instanceof ResourceHttpError && fallback.status === 404) return null; throw fallback; }
      } else if (optional) return null;
      else throw error;
    }
    const component: Component = { type, name, src: new URL(url).pathname.split('/').pop() };
    if (type === 'motion') {
      const bytes = await this.buffer(url);
      if (bytes.byteLength < 12) throw Error(`${url}: truncated binary motion prefix`);
      const signature = new Uint8Array(bytes, 0, 8);
      if ([77, 79, 84, 73, 79, 78, 0, 0].some((value, index) => value !== signature[index])) {
        throw Error(`${url}: invalid binary motion signature`);
      }
      const length = new DataView(bytes).getUint32(8, true);
      if (length > bytes.byteLength - 12) throw Error(`${url}: truncated binary motion header`);
      const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, 12, length)));
      if (metadata.name !== undefined) component.name = metadata.name;
      if (metadata.description !== undefined) component.description = metadata.description;
      if (metadata.motionGroup !== undefined) component.motionGroup = metadata.motionGroup;
    } else Object.assign(component, { fade_in: 500, fade_out: 500 });
    return { type, name, config: url, component, motionGroup: component.motionGroup, basePath: new URL('.', url).href };
  }

  async resolveExpression(name: string, { optional = false } = {}) {
    const url = new URL(`mtn_exp/${name}.exp.json`, this.root).href;
    try { await this.buffer(url); }
    catch (error) { if (optional && error instanceof ResourceHttpError && error.status === 404) return null; throw error; }
    const component = { type: 'garupa-expression', name, src: new URL(url).pathname.split('/').pop() };
    return { type: component.type, name, config: url, component, basePath: new URL('.', url).href };
  }

  async preload(type: string, name: string) {
    const entry = await this.resolve(this.find(type, name));
    const source = entry.component?.script ?? entry.component?.src;
    if (source) await this.buffer(new URL(source, entry.config).href);
    return entry;
  }
  async preloadModelDependencies(model: FixedResourceEntry) {
    const bytes = await this.buffer(new URL(model.component!.model, model.config).href);
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== 0x46546c67) throw Error(`${model.name}: expected GLB`);
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true))));
    const shaders = new Set<string>((gltf.materials ?? []).map((m: Component) => m.extras?.shader).filter(Boolean));
    for (const shader of shaders) await this.preload('shader', shader);
    for (const behavior of model.component!.behaviors ?? []) {
      try { await this.preload('behavior', behavior.name); }
      catch (error) { if (behavior.required !== false) throw error; }
    }
    for (const adapter of this.entries.filter(e => e.type === 'garupa-expression-adapter'
      && e.motionGroup === model.component!.motionGroup)) await this.preload(adapter.type, adapter.name);
    if (model.component!.defaultMotion) await this.resolveMotion(model.component!.defaultMotion, { optional: true });
  }
}

const catalogs = new Map<string, FixedGltfResources>();
export function fixedGltfResources(base = document.baseURI) {
  const root = new URL('./game/3d/', base).href;
  if (!catalogs.has(root)) catalogs.set(root, new FixedGltfResources(base));
  return catalogs.get(root)!;
}

export async function resolveFigureConfig(url: string, base = document.baseURI) {
  const original = new URL(url, base);
  const figureRoot = new URL('./game/figure/', base);
  const resources = fixedGltfResources(base);
  const root = new URL('figure/', resources.root);
  const candidate = original.href.startsWith(figureRoot.href)
    ? new URL(original.href.slice(figureRoot.href.length), root).href : original.href;
  let resolved = candidate;
  let config: Component;
  try { config = await resources.fetch(candidate); }
  catch (error) {
    if (!(error instanceof ResourceHttpError) || error.status !== 404 || candidate === original.href) throw error;
    resolved = original.href; config = await resources.fetch(resolved);
  }
  return { url: resolved, gltf: Array.isArray(config.components), config };
}
