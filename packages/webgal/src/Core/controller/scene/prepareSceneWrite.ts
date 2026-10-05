import { WebGAL } from '@/Core/WebGAL';
import { sceneFetcher } from './sceneFetcher';
import { sceneParser } from '@/Core/parser/sceneParser';
import type { IScene } from './sceneInterface';
import { stageStateManager } from '@/Core/Modules/stage/stageStateManager';
import { beginCharacterLoading, prepareSceneCharacters } from '@/Core/util/sceneCharacterLoading';
import { cancelPendingForward, continueSentence } from '@/Core/controller/gamePlay/nextSentence';
import { logger } from '@/Core/util/logger';
import cloneDeep from 'lodash/cloneDeep';

/** Publish scene identity, stack and cursor only after preparation succeeds. */
export function prepareSceneWrite(url: string, name: string, publish: (scene: IScene) => void): Promise<void> | undefined {
  const manager = WebGAL.sceneManager;
  if (manager.lockSceneWrite) return;
  manager.lockSceneWrite = true;
  cancelPendingForward();
  const ticket = beginCharacterLoading('scene');
  const fastPreview = WebGAL.gameplay.isFastPreview;
  const sourceScene = manager.sceneData.currentScene;
  const sourceCursor = manager.sceneData.currentSentenceId;
  let ready = false;
  const pending: Promise<void> = sceneFetcher(url).then(async raw => {
    if (manager.sceneWritePromise !== pending || !ticket.isCurrent()) return;
    const scene = sceneParser(raw, name, url);
    // Editor fast preview prepares only the final displayed stage in commitForward.
    if (!fastPreview) {
      await prepareSceneCharacters(scene, cloneDeep(stageStateManager.getCalculationStageState()), ticket.signal);
    }
    if (manager.sceneWritePromise !== pending || !ticket.isCurrent()) return;
    publish(scene);
    ready = true;
  }).catch(error => {
    if (manager.sceneWritePromise !== pending || !ticket.isCurrent()) return;
    logger.error('场景准备失败', error);
    ticket.fail(error, () => prepareSceneWrite(url, name, publish));
  }).finally(async () => {
    if (manager.sceneWritePromise !== pending) return;
    manager.sceneWritePromise = null;
    manager.lockSceneWrite = false;
    if (!ready) return;
    ticket.succeed();
    if (!fastPreview) await continueSentence();
  });
  manager.sceneWritePromise = pending;
  ticket.signal.addEventListener('abort', () => {
    if (manager.sceneWritePromise !== pending) return;
    if (manager.sceneData.currentScene === sourceScene) manager.sceneData.currentSentenceId = sourceCursor;
    manager.sceneWritePromise = null;
    manager.lockSceneWrite = false;
  }, { once: true });
  return pending;
}
