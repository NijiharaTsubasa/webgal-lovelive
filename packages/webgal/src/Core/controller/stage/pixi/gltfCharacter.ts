import type { OffscreenCharacter } from 'webgal-lovelive-gltf-renderer';
import type { BlinkParam } from '@/Core/live2DCore';

/** Package entry points are config.json; ordinary Live2D model.json is unaffected. */
export function isGltfCharacterUrl(url: string): boolean {
  return new URL(url, document.baseURI).pathname.endsWith('/config.json');
}

async function characterOptions(url: string, width: number, height: number) {
  const globals = globalThis as typeof globalThis & { live2dPromise?: Promise<unknown> };
  if (globals.live2dPromise) await globals.live2dPromise;
  return {
    modelUrl: new URL(url, document.baseURI).href,
    indexUrl: new URL('./game/gltf-resources.json', document.baseURI).href,
    runtime: globalThis,
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
  const { OffscreenCharacter } = await import('webgal-lovelive-gltf-renderer');
  await OffscreenCharacter.preloadNamed(new URL('./game/gltf-resources.json', document.baseURI).href, requests);
}

export async function createGltfCharacter(url: string, width: number, height: number) {
  const { OffscreenCharacter } = await import('webgal-lovelive-gltf-renderer');
  const options = await characterOptions(url, width, height);
  const character = (await OffscreenCharacter.takePreloaded(options)) ?? (await OffscreenCharacter.create(options));
  return new GltfCharacterRuntime(character);
}

/** Owns commands and lifetime independently of the mutable stage-object key. */
export class GltfCharacterRuntime {
  private disposed = false;
  private commands: Promise<void> = Promise.resolve();
  private motion: string | undefined;
  private expression: string | undefined;
  private blink: BlinkParam | undefined;
  public constructor(private readonly character: OffscreenCharacter) {}
  public get canvas(): HTMLCanvasElement {
    return this.character.canvas;
  }
  private enqueue(command: () => Promise<void>) {
    this.commands = this.commands
      .then(() => (this.disposed ? undefined : command()))
      .catch((error) => console.error('glTF character command failed', error));
  }
  public setMotion(name: string) {
    if (this.motion === name) return;
    this.motion = name;
    this.enqueue(() => this.character.setMotion(name));
  }
  public setExpression(name: string) {
    if (this.expression === name) return;
    this.expression = name;
    this.enqueue(() => this.character.setExpression(name));
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
  public update(delta: number) {
    if (!this.disposed) this.character.update(delta);
  }
  public dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.character.dispose();
  }
}
