import { commandType, IScene } from '@/Core/controller/scene/sceneInterface';
import { assetsPrefetcher } from '@/Core/util/prefetcher/assetsPrefetcher';
import { WebGAL } from '@/Core/WebGAL';
import { setGltfPreloadRequests, preloadGltfNamedResources } from '@/Core/controller/stage/pixi/gltfCharacter';
import { prewarmGltfPredictions } from '@/Core/controller/stage/pixi/gltfSceneResidency';
import { logger } from '@/Core/util/logger';
import { stageStateManager } from '@/Core/Modules/stage/stageStateManager';
import { planGltfPreloads, planGltfChoiceBranch, planGltfSceneTransition, mergeGltfBranchPlans, planGltfBackgroundBatches, type GltfPreloadPlan } from './gltfPrefetchPlan';
import { scenePrefetcher } from './scenePrefetcher';

let previousScene: IScene | undefined;
let previousSentence = -1;
let visit = 0;
let hasGltfPlan = false;
let generation = 0;
const choiceScenes = new Map<string, Promise<string>>();
const parsedChoiceScenes = new Map<string, IScene>();

function applyPlan(plan: GltfPreloadPlan) {
  if (plan.requests.length || hasGltfPlan) {
    hasGltfPlan = plan.requests.length > 0;
    void setGltfPreloadRequests(plan.requests, WebGAL.stageWidth, WebGAL.stageHeight)
      .catch(error => logger.warn('glTF 实例预热失败', error));
  }
  if (plan.named.length) {
    void preloadGltfNamedResources(plan.named).catch(error => logger.warn('glTF 动作/表情预加载失败', error));
  }
  assetsPrefetcher(plan.sentences.flatMap(sentence => sentence.sentenceAssets),
    { ignoreLineGate: true, priority: true });
}

/** Refresh after a committed stage state, including restores and scene returns. */
export const prefetchSceneByProgress = (scene: IScene, currentSentenceId: number) => {
  const currentGeneration = ++generation;
  if (scene !== previousScene || currentSentenceId < previousSentence) visit++;
  previousScene = scene;
  previousSentence = currentSentenceId;
  const state = stageStateManager.getViewStageState();
  const currentVisit = `${visit}:${scene.sceneUrl}`;
  const plan = planGltfPreloads(scene, Math.max(0, currentSentenceId), state, currentVisit);
  const branches = plan.choice?.branches ?? [];
  const transition = plan.transition;
  const targetVisit = transition ? `${visit + 1}:${transition.target}` : '';
  let transitionPlan = transition && parsedChoiceScenes.has(transition.target)
    ? planGltfSceneTransition(plan, parsedChoiceScenes.get(transition.target)!, state, targetVisit) : undefined;
  const branchPlans = branches.map((branch, index) => branch.scene
    ? (parsedChoiceScenes.has(branch.target)
      ? planGltfChoiceBranch(plan, index, parsedChoiceScenes.get(branch.target)!, state, currentVisit) : undefined)
    : planGltfChoiceBranch(plan, index, scene, state, currentVisit));
  const publish = () => {
    applyPlan(mergeGltfBranchPlans(plan, [...branchPlans, transitionPlan]));
    void prewarmGltfPredictions(planGltfBackgroundBatches(plan, [...branchPlans, transitionPlan]))
      .catch(error => logger.warn('glTF 后台实例预热失败', error));
  };
  publish();
  // Keep only the currently reachable scene texts; pending fetches cannot publish stale plans.
  const targets = new Set(branches.filter(branch => branch.scene).map(branch => branch.target));
  if (transition) targets.add(transition.target);
  for (const url of choiceScenes.keys()) if (!targets.has(url)) choiceScenes.delete(url);
  for (const url of parsedChoiceScenes.keys()) if (!targets.has(url)) parsedChoiceScenes.delete(url);
  const edges = [...branches];
  if (transition) edges.push({ target: transition.target, scene: true });
  edges.forEach((branch, index) => {
    if (index === branches.length ? transitionPlan : branchPlans[index]) return;
    if (!branch.scene) return;
    void (async () => {
      try {
        // Lazy imports keep the parser/engine initialization graph acyclic.
        const [{ sceneFetcher }, { sceneParser }] = await Promise.all([
          import('@/Core/controller/scene/sceneFetcher'), import('@/Core/parser/sceneParser'),
        ]);
        if (generation !== currentGeneration) return;
        let pending = choiceScenes.get(branch.target);
        if (!pending) {
          pending = sceneFetcher(branch.target);
          choiceScenes.set(branch.target, pending);
          const request = pending;
          void pending.catch(() => {
            if (choiceScenes.get(branch.target) === request) choiceScenes.delete(branch.target);
          });
        }
        const raw = await pending;
        if (generation !== currentGeneration) return;
        let targetScene = parsedChoiceScenes.get(branch.target);
        if (!targetScene) {
          targetScene = sceneParser(raw, branch.target, branch.target);
          parsedChoiceScenes.set(branch.target, targetScene);
        }
        if (index === branches.length) transitionPlan = planGltfSceneTransition(plan, targetScene, state, targetVisit);
        else branchPlans[index] = planGltfChoiceBranch(plan, index, targetScene, state, currentVisit);
        publish();
      } catch (error) {
        if (generation === currentGeneration) logger.warn('glTF 场景预测预加载失败', error);
      }
    })();
  });
  const subScenes = new Set<string>();
  let commands = 0;
  for (const sentence of scene.sentenceList.slice(Math.max(0, currentSentenceId), currentSentenceId + 2000)) {
    if (sentence.isLineBreakHolder || sentence.command === commandType.comment) continue;
    if (++commands > 36) break;
    for (const url of sentence.subScene) if (url && !targets.has(url)) subScenes.add(url);
  }
  if (subScenes.size) scenePrefetcher([...subScenes]);
};

export const prefetchCurrentSceneByProgress = () => {
  const { currentScene, currentSentenceId } = WebGAL.sceneManager.sceneData;
  prefetchSceneByProgress(currentScene, currentSentenceId);
};
