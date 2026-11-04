import type { ISentence } from '@/Core/controller/scene/sceneInterface';

interface OfflineExportHost {
  register(bindings: Record<string, unknown>): void;
  commands(handlers: object): void;
  observe(sentence: ISentence): void;
  beforeNext(): boolean;
  scheduleAuto: typeof setTimeout;
  scheduleAssetMount(callback: () => void): void;
  characterFailed(error: unknown): void;
}

export const offlineExportHost = (globalThis as typeof globalThis & {
  __webgalOfflineExportHost?: OfflineExportHost;
}).__webgalOfflineExportHost;

export function scheduleAssetMount(callback: () => void) {
  if (offlineExportHost) offlineExportHost.scheduleAssetMount(callback);
  else setTimeout(callback, 0);
}
