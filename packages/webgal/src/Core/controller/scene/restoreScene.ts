import { ISceneEntry } from '@/Core/Modules/scene';
import { WebGAL } from '@/Core/WebGAL';
import { prepareSceneWrite } from './prepareSceneWrite';

export const restoreScene = (entry: ISceneEntry, beforePublish?: () => void) =>
  prepareSceneWrite(entry.sceneUrl, entry.sceneName, scene => {
    beforePublish?.();
    WebGAL.sceneManager.sceneData.currentScene = scene;
    WebGAL.sceneManager.sceneData.currentSentenceId = entry.continueLine + 1;
  });
