import type { IScene } from '@/Core/controller/scene/sceneInterface';
import type { IStageState } from '@/Core/Modules/stage/stageInterface';

export type CharacterLoadingMode = 'scene' | 'on-demand';
export interface CharacterLoadingStatus {
  phase: 'idle' | 'loading' | 'error';
  kind?: 'scene' | 'stage';
  error?: unknown;
}
export interface SceneCharacterLoadingHooks {
  prepareStage(stage: IStageState, signal: AbortSignal): Promise<void>;
  prepareScene(scene: IScene, state: IStageState, signal: AbortSignal): Promise<void>;
  releaseScene?(): void;
}
let hooks: SceneCharacterLoadingHooks | undefined;
let mode: CharacterLoadingMode = 'scene';
let status: CharacterLoadingStatus = { phase: 'idle' };
let active: AbortController | undefined;
let retry: (() => void | Promise<void>) | undefined;
const listeners = new Set<(status: CharacterLoadingStatus) => void>();
const publish = (next: CharacterLoadingStatus) => {
  status = next;
  for (const listener of listeners) listener(status);
};
export function registerSceneCharacterLoadingHooks(value: SceneCharacterLoadingHooks) { hooks = value; }
export function releaseSceneCharacters() { hooks?.releaseScene?.(); }
export function getCharacterLoadingMode() { return mode; }
export function setCharacterLoadingMode(value: CharacterLoadingMode) {
  if (value !== 'scene' && value !== 'on-demand') throw Error('Invalid character loading mode');
  mode = value;
}
export function getCharacterLoadingStatus() { return status; }
export function isCharacterLoadingBusy() { return status.phase !== 'idle'; }
export function subscribeCharacterLoading(listener: (status: CharacterLoadingStatus) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function cancelCharacterLoading() {
  active?.abort(); active = undefined; retry = undefined;
  publish({ phase: 'idle' });
}
export async function retryCharacterLoading() {
  const action = retry;
  if (status.phase !== 'error' || !action) return;
  retry = undefined;
  await action();
}
export function beginCharacterLoading(kind: 'scene' | 'stage') {
  active?.abort();
  const controller = new AbortController();
  active = controller; retry = undefined;
  const isCurrent = () => active === controller && !controller.signal.aborted;
  publish({ phase: 'loading', kind });
  return {
    signal: controller.signal, isCurrent,
    succeed() {
      if (!isCurrent()) return;
      active = undefined; retry = undefined; publish({ phase: 'idle' });
    },
    fail(error: unknown, action: () => void | Promise<void>) {
      if (!isCurrent()) return;
      retry = action; publish({ phase: 'error', kind, error });
    },
  };
}
export async function prepareStageCharacters(stage: IStageState, signal: AbortSignal) {
  if (signal.aborted) return;
  await hooks?.prepareStage(stage, signal);
}
export async function prepareSceneCharacters(scene: IScene, state: IStageState, signal: AbortSignal) {
  if (signal.aborted || mode !== 'scene') return;
  await hooks?.prepareScene(scene, state, signal);
}
