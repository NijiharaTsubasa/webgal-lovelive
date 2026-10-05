import cloneDeep from 'lodash/cloneDeep';
import type { ISaveScene } from '@/store/userDataInterface';
import type { IStageState } from '@/Core/Modules/stage/stageInterface';
import { WebGAL } from '@/Core/WebGAL';
import { sceneFetcher } from '../scene/sceneFetcher';
import { sceneParser } from '@/Core/parser/sceneParser';
import { logger } from '@/Core/util/logger';
import { cancelPendingForward } from '@/Core/controller/gamePlay/nextSentence';
import { beginCharacterLoading, prepareSceneCharacters, prepareStageCharacters } from '@/Core/util/sceneCharacterLoading';

/** Prepare the saved scene and complete stage before publishing either. */
export function restoreStageScene(saved: ISaveScene, applyStage: () => void, refetch = true, stage?: IStageState): Promise<void> {
  const manager = WebGAL.sceneManager;
  const snapshot = cloneDeep(saved);
  const stageSnapshot = stage && cloneDeep(stage);
  cancelPendingForward();
  const ticket = beginCharacterLoading('scene');
  manager.lockSceneWrite = true;
  const pending: Promise<void> = (refetch ? sceneFetcher(snapshot.sceneUrl).then(raw =>
    sceneParser(raw, snapshot.sceneName, snapshot.sceneUrl)) : Promise.resolve(manager.sceneData.currentScene))
    .then(async scene => {
      if (manager.sceneWritePromise !== pending || !ticket.isCurrent()) return;
      if (stageSnapshot) {
        await prepareSceneCharacters(scene, stageSnapshot, ticket.signal);
        if (!ticket.isCurrent()) return;
        await prepareStageCharacters(stageSnapshot, ticket.signal);
      }
      if (manager.sceneWritePromise !== pending || !ticket.isCurrent()) return;
      manager.sceneData.currentScene = scene;
      manager.settledScenes.add(snapshot.sceneUrl);
      manager.sceneData.currentSentenceId = snapshot.currentSentenceId;
      manager.sceneData.sceneStack = snapshot.sceneStack;
      manager.sceneData.currentLocals = snapshot.currentLocals ?? {};
      manager.lockSceneWrite = false;
      ticket.succeed();
      applyStage();
    }).catch(error => {
      if (manager.sceneWritePromise !== pending || !ticket.isCurrent()) return;
      logger.error('恢复场景失败', error);
      ticket.fail(error, () => restoreStageScene(snapshot, applyStage, refetch, stageSnapshot));
    }).finally(() => {
      if (manager.sceneWritePromise !== pending) return;
      manager.sceneWritePromise = null;
      manager.lockSceneWrite = false;
    });
  manager.sceneWritePromise = pending;
  ticket.signal.addEventListener('abort', () => {
    if (manager.sceneWritePromise !== pending) return;
    manager.sceneWritePromise = null;
    manager.lockSceneWrite = false;
  }, { once: true });
  return pending;
}
