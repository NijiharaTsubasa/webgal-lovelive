import { IScene } from '@/Core/controller/scene/sceneInterface';
import { assetsPrefetcher } from '@/Core/util/prefetcher/assetsPrefetcher';
import { scenePrefetcher } from '@/Core/util/prefetcher/scenePrefetcher';
import { WebGAL } from '@/Core/WebGAL';
import { isGltfCharacterUrl, preloadGltfNamedResources } from '@/Core/controller/stage/pixi/gltfCharacter';
import { logger } from '@/Core/util/logger';

const PROGRESS_ASSET_LOOKAHEAD = 20;
const PROGRESS_SUB_SCENE_LOOKAHEAD = 36;
let lastProgressPrefetchMark = '';

const uniqueAssetsByUrl = (scene: IScene, startLine: number, lookahead: number) => {
  const assetMap = new Map<string, IScene['assetsList'][number]>();
  for (const sentence of scene.sentenceList.slice(startLine, startLine + lookahead + 1)) {
    for (const asset of sentence.sentenceAssets) {
      if (asset.url && !assetMap.has(asset.url)) {
        assetMap.set(asset.url, asset);
      }
    }
  }
  return [...assetMap.values()];
};

const uniqueSubScenes = (scene: IScene, startLine: number, lookahead: number) => {
  const sceneSet = new Set<string>();
  for (const sentence of scene.sentenceList.slice(startLine, startLine + lookahead + 1)) {
    for (const subScene of sentence.subScene) {
      if (subScene) {
        sceneSet.add(subScene);
      }
    }
  }
  return [...sceneSet];
};

export const prefetchSceneByProgress = (scene: IScene, currentSentenceId: number, force = false) => {
  if (!scene.sceneUrl) {
    return;
  }
  const mark = `${scene.sceneUrl}#${currentSentenceId}`;
  if (!force && mark === lastProgressPrefetchMark) {
    return;
  }
  lastProgressPrefetchMark = mark;
  const startLine = Math.max(0, currentSentenceId);
  const nextAssets = uniqueAssetsByUrl(scene, startLine, PROGRESS_ASSET_LOOKAHEAD);
  const nextSubScenes = uniqueSubScenes(scene, startLine, PROGRESS_SUB_SCENE_LOOKAHEAD);
  const hasGltf = nextAssets.some(asset => isGltfCharacterUrl(asset.url))
    || WebGAL.gameplay.pixiStage?.figureObjects.some(object => object.sourceType === 'gltf');
  if (hasGltf) {
    const requests = scene.sentenceList.slice(startLine, startLine + PROGRESS_ASSET_LOOKAHEAD + 1)
      .flatMap(sentence => sentence.args.flatMap(arg =>
        (arg.key === 'motion' || arg.key === 'expression') && typeof arg.value === 'string' && arg.value
          ? [{ kind: arg.key as 'motion' | 'expression', name: arg.value }] : []));
    void preloadGltfNamedResources(requests).catch(error => logger.warn('glTF 动作/表情预加载失败', error));
  }
  if (nextAssets.length > 0) {
    assetsPrefetcher(nextAssets, { ignoreLineGate: true });
  }
  if (nextSubScenes.length > 0) {
    scenePrefetcher(nextSubScenes);
  }
};

export const prefetchCurrentSceneByProgress = (force = false) => {
  const { currentScene, currentSentenceId } = WebGAL.sceneManager.sceneData;
  prefetchSceneByProgress(currentScene, currentSentenceId, force);
};
