import { webgalStore } from '@/store/store';
import type { OffscreenCharacter } from 'webgal-lovelive-gltf-renderer';
import type { BlinkParam, FocusParam } from '@/Core/live2DCore';
import type { GltfPreloadRequest } from '@/Core/util/prefetcher/gltfPrefetchPlan';
import { fixedGltfResources, resolveFigureConfig } from './fixedGltfResources';

export interface GltfInitialState { motion?: string; expression?: string; focus?: FocusParam }
const pendingClaims = new Set<Promise<void>>();

/** Package entry points are config.json; ordinary Live2D model.json is unaffected. */
export function isGltfCharacterUrl(url: string): boolean {
  return new URL(url, document.baseURI).pathname.endsWith('/config.json');
}

export async function characterOptions(url: string, width: number, height: number) {
  const globals = globalThis as typeof globalThis & { live2dPromise?: Promise<unknown> };
  if (globals.live2dPromise) await globals.live2dPromise;
  const resolved = await resolveFigureConfig(url);
  if (!resolved.gltf) throw Error(`${resolved.url}: not a glTF model`);
  const resourceCatalog = await fixedGltfResources().load();
  return {
    modelUrl: resolved.url,
    indexUrl: resourceCatalog.indexUrl,
    resourceCatalog,
    runtime: globalThis,
    meshClothEnabled: webgalStore.getState().userData.optionData.meshClothEnabled === true,
    motion: '',
    expression: '',
    // A full-stage transparent canvas makes the existing left/right figure
    // placement converge on the center. Keep a portrait footprint, shared by
    // preload and display so the warmed instance is reusable.
    width: Math.min(width, Math.round(height * 0.75)),
    height,
    // Match the native portrait's head-to-hip composition, not a full-body thumbnail.
    framing: {
      viewHeight: 1.36 / 1.18,
      centerY: 1.195,
      // Portrait composition: 50 stage units down at 1440px and M_3_1_0's 1.25 fit.
      groupOffsets: { llas: (50 / (1440 * 1.25)) * (1.36 / 1.18) },
    },
  };
}

export async function preloadGltfCharacter(url: string, width: number, height: number): Promise<void> {
  const { OffscreenCharacter } = await import('webgal-lovelive-gltf-renderer');
  await OffscreenCharacter.preload(await characterOptions(url, width, height));
}

export async function preloadGltfNamedResources(requests: Array<{ kind: 'motion' | 'expression'; name: string }>) {
  if (!requests.length) return;
  const { OffscreenCharacter } = await import('webgal-lovelive-gltf-renderer');
  const resourceCatalog = await fixedGltfResources().load();
  await OffscreenCharacter.preloadNamed(resourceCatalog.indexUrl, requests, resourceCatalog);
}

export async function setGltfPreloadRequests(requests: GltfPreloadRequest[], width: number, height: number) {
  // Named inputs share the fetch cache; GPU preparation belongs to the residency owner.
  const resolved = await Promise.all(requests.map(async request =>
    (await resolveFigureConfig(request.url)).gltf ? request : null));
  await preloadGltfNamedResources(resolved.filter((item): item is GltfPreloadRequest => !!item).flatMap(request => [
    ...(request.motion ? [{ kind: 'motion' as const, name: request.motion }] : []),
    ...(request.expression ? [{ kind: 'expression' as const, name: request.expression }] : []),
  ]));

}

export async function createGltfCharacter(url: string, width: number, height: number, initial: GltfInitialState = {}) {
  let release!: () => void;
  const claim = new Promise<void>(resolve => { release = resolve; });
  pendingClaims.add(claim);
  try {
    const { OffscreenCharacter } = await import('webgal-lovelive-gltf-renderer');
    const options = { ...await characterOptions(url, width, height),
      motion: initial.motion ?? '', expression: initial.expression ?? '',
      ...(initial.focus ? {focus: initial.focus} : {}) };
    const pending = OffscreenCharacter.takePreloaded(options);
    pendingClaims.delete(claim);
    release();
    const character = (await pending) ?? (await OffscreenCharacter.create(options));
    // A pooled instance was prepared before this display's stage state was known.
    if (initial.focus) character.setFocus(initial.focus);
    return new GltfCharacterRuntime(character, options);
  } finally {
    pendingClaims.delete(claim);
    release();
  }
}

/** Owns commands and lifetime independently of the mutable stage-object key. */
export class GltfCharacterRuntime {
  private disposed = false;
  private commands: Promise<void> = Promise.resolve();
  private motion: string | undefined;
  private expression: string | undefined;
  private blink: BlinkParam | undefined;
  private focus: FocusParam | undefined;
  private commandErrors: Partial<Record<'motion' | 'expression', unknown>> = {};
  private commandGenerations = { motion: 0, expression: 0 };
  private active = true;
  public constructor(private readonly character: OffscreenCharacter, initial: GltfInitialState = {},
    private readonly release?: () => void) {
    this.motion = initial.motion;
    this.expression = initial.expression;
    this.focus = initial.focus && { ...initial.focus };
  }
  public get canvas(): HTMLCanvasElement {
    return this.character.canvas;
  }
  public get isActive() { return this.active && !this.disposed; }
  public activate() { this.disposed = false; this.active = true; }
  public suspend() { this.active = false; }
  private enqueue(kind: 'motion' | 'expression', command: () => Promise<void>) {
    const generation = ++this.commandGenerations[kind];
    delete this.commandErrors[kind];
    this.commands = this.commands
      .then(() => (this.disposed ? undefined : command()))
      .catch((error) => {
        if (generation === this.commandGenerations[kind]) {
          this[kind] = undefined;
          this.commandErrors[kind] = error;
        }
        console.error('glTF character command failed', error);
      });
  }
  public setMotion(name: string) {
    if (this.motion === name) return;
    this.motion = name;
    this.enqueue('motion', () => this.character.setMotion(name));
  }
  public setExpression(name: string) {
    if (this.expression === name) return;
    this.expression = name;
    this.enqueue('expression', () => this.character.setExpression(name));
  }
  /** Call before attaching the ticker; commands arriving during preparation are included. */
  public async prepare() {
    let snapshot: Promise<void>;
    do {
      snapshot = this.commands;
      await snapshot;
      if (this.disposed) return;
      const errors = Object.values(this.commandErrors);
      if (errors.length) throw errors[0];
      await this.character.prepare();
    } while (snapshot !== this.commands);
  }
  public setBlinkParameters(config: BlinkParam) {
    const next = { ...config };
    if (JSON.stringify(this.blink) === JSON.stringify(next)) return;
    this.blink = next;
    if (!this.disposed) this.character.setBlinkParameters(next);
  }
  public setMouth(value: number | null) {
    if (!this.disposed) this.character.setMouth(value);
  }
  public setFocus(value: FocusParam) {
    if (this.disposed || (this.focus?.x === value.x && this.focus?.y === value.y
      && this.focus?.instant === value.instant)) return;
    this.focus = { ...value };
    this.character.setFocus(this.focus);
  }
  public update(delta: number) {
    if (this.isActive) this.character.update(delta);
  }
  public dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    if (this.release) this.release();
    else this.character.dispose();
  }
}
