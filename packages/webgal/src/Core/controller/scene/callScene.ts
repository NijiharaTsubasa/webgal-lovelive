import { clearPrefetchLinks } from '@/Core/util/prefetcher/assetsPrefetcher';
import { WebGAL } from '@/Core/WebGAL';
import { IGameVar } from '@/Core/Modules/stage/stageInterface';
import { MAX_SCENE_STACK_DEPTH } from '@/Core/Modules/scene';
import { logger } from '@/Core/util/logger';
import { prepareSceneWrite } from './prepareSceneWrite';

export const callScene = (sceneUrl: string, sceneName: string, locals: IGameVar = {}, writeReturnTo?: string) => {
  if (WebGAL.sceneManager.sceneData.sceneStack.length >= MAX_SCENE_STACK_DEPTH) {
    logger.error(`场景调用层数超过 ${MAX_SCENE_STACK_DEPTH}`, sceneUrl); return;
  }
  const continueLine = WebGAL.sceneManager.sceneData.currentSentenceId;
  return prepareSceneWrite(sceneUrl, sceneName, scene => {
    WebGAL.sceneManager.pushFrame(locals, writeReturnTo, continueLine);
    WebGAL.sceneManager.sceneData.currentScene = scene;
    WebGAL.sceneManager.sceneData.currentSentenceId = 0;
    clearPrefetchLinks();
    WebGAL.sceneManager.settledScenes.add(sceneUrl);
    WebGAL.flowchartManager.waitForCurrentSceneDialog();
  });
};
