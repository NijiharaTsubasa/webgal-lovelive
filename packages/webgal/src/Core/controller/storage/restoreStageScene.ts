import cloneDeep from 'lodash/cloneDeep';
import type { ISaveScene } from '@/store/userDataInterface';
import { WebGAL } from '@/Core/WebGAL';
import { sceneFetcher } from '../scene/sceneFetcher';
import { sceneParser } from '@/Core/parser/sceneParser';
import { logger } from '@/Core/util/logger';

/** Restore scene identity and its stage in one turn; only the latest request owns the write. */
export function restoreStageScene(saved: ISaveScene, applyStage: () => void, refetch = true): Promise<void> {
  const manager = WebGAL.sceneManager;
  const snapshot = cloneDeep(saved);
  const apply = () => {
    manager.sceneData.currentSentenceId = snapshot.currentSentenceId;
    manager.sceneData.sceneStack = snapshot.sceneStack;
    manager.sceneData.currentLocals = snapshot.currentLocals ?? {};
    applyStage();
  };
  if (!refetch) {
    manager.sceneWritePromise = null;
    manager.lockSceneWrite = false;
    apply();
    return Promise.resolve();
  }
  manager.lockSceneWrite = true;
  const pending = sceneFetcher(snapshot.sceneUrl).then(rawScene => {
    if (manager.sceneWritePromise !== pending) return;
    manager.sceneData.currentScene = sceneParser(rawScene, snapshot.sceneName, snapshot.sceneUrl);
    manager.settledScenes.add(snapshot.sceneUrl);
    // A commit now observes a coherent scene, cursor and stage, including its prefetch hook.
    manager.lockSceneWrite = false;
    apply();
  }).catch(error => {
    if (manager.sceneWritePromise === pending) logger.error('恢复场景失败', error);
  }).finally(() => {
    if (manager.sceneWritePromise !== pending) return;
    manager.sceneWritePromise = null;
    manager.lockSceneWrite = false;
  });
  manager.sceneWritePromise = pending;
  return pending;
}
