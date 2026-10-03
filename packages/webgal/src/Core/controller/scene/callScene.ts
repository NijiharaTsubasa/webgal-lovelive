import { sceneFetcher } from './sceneFetcher';
import { sceneParser } from '../../parser/sceneParser';
import { logger } from '../../util/logger';
import { continueSentence } from '@/Core/controller/gamePlay/nextSentence';
import { clearPrefetchLinks } from '@/Core/util/prefetcher/assetsPrefetcher';

import { WebGAL } from '@/Core/WebGAL';
import { IGameVar } from '@/Core/Modules/stage/stageInterface';
import { MAX_SCENE_STACK_DEPTH } from '@/Core/Modules/scene';

/**
 * 调用场景
 * @param sceneUrl 场景路径
 * @param sceneName 场景名称
 * @param locals 传入被调用场景的局部变量
 * @param writeReturnTo 返回值写回本场景的哪个变量
 */
export const callScene = (sceneUrl: string, sceneName: string, locals: IGameVar = {}, writeReturnTo?: string) => {
  if (WebGAL.sceneManager.lockSceneWrite) {
    return;
  }
  if (WebGAL.sceneManager.sceneData.sceneStack.length >= MAX_SCENE_STACK_DEPTH) {
    logger.error(`场景调用层数超过 ${MAX_SCENE_STACK_DEPTH}，可能存在 callScene 无限递归`, sceneUrl);
    return;
  }
  WebGAL.sceneManager.lockSceneWrite = true;
  const isFastPreviewSceneWrite = WebGAL.gameplay.isFastPreview;
  let shouldAutoNext = false;
  const continueLine = WebGAL.sceneManager.sceneData.currentSentenceId;
  // 场景写入到运行时
  const sceneWritePromise = sceneFetcher(sceneUrl)
    .then((rawScene) => {
      if (WebGAL.sceneManager.sceneWritePromise !== sceneWritePromise) return;
      const scene = sceneParser(rawScene, sceneName, sceneUrl);
      WebGAL.sceneManager.pushFrame(locals, writeReturnTo, continueLine);
      WebGAL.sceneManager.sceneData.currentScene = scene;
      WebGAL.sceneManager.sceneData.currentSentenceId = 0;
      clearPrefetchLinks();
      WebGAL.sceneManager.settledScenes.add(sceneUrl); // 放入已加载场景列表，避免递归加载相同场景
      WebGAL.flowchartManager.waitForCurrentSceneDialog();
      logger.debug('现在调用场景，调用结果：', WebGAL.sceneManager.sceneData);
      shouldAutoNext = !isFastPreviewSceneWrite;
    })
    .catch((e) => {
      if (WebGAL.sceneManager.sceneWritePromise !== sceneWritePromise) return;
      logger.error('场景调用错误', e);
    })
    .finally(() => {
      if (WebGAL.sceneManager.sceneWritePromise !== sceneWritePromise) return;
      WebGAL.sceneManager.lockSceneWrite = false;
      if (WebGAL.sceneManager.sceneWritePromise === sceneWritePromise) {
        WebGAL.sceneManager.sceneWritePromise = null;
      }
      if (shouldAutoNext) {
        // 场景写入完成后的第一句推进是内核流程，不应触发用户 next 语义。
        continueSentence();
      }
    });
  WebGAL.sceneManager.sceneWritePromise = sceneWritePromise;
};
