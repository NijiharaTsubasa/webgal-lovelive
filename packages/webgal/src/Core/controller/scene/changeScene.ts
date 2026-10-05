import { clearPrefetchLinks } from '@/Core/util/prefetcher/assetsPrefetcher';
import { WebGAL } from '@/Core/WebGAL';
import { prepareSceneWrite } from './prepareSceneWrite';

export const changeScene = (sceneUrl: string, sceneName: string) =>
  prepareSceneWrite(sceneUrl, sceneName, scene => {
    WebGAL.sceneManager.sceneData.currentScene = scene;
    WebGAL.sceneManager.sceneData.currentSentenceId = 0;
    clearPrefetchLinks();
    WebGAL.sceneManager.settledScenes.add(sceneUrl);
    WebGAL.flowchartManager.waitForCurrentSceneDialog();
  });
