import { commandType, type IScene, type ISentence } from '@/Core/controller/scene/sceneInterface';
import {
  FIGURE_POSITIONS, figureStateKeyByPosition, normalizeFigureBounds,
  type IFigurePosition, type IStageState,
} from '@/Core/Modules/stage/stageInterface';
import { getBooleanArgByKey, getFigurePositionFromArgs, getStringArgByKey } from '@/Core/util/getSentenceArg';

export interface GltfPreloadRequest {
  url: string;
  motion: string;
  expression: string;
  preloadId: string;
}

export interface ProjectedGltfFigure {
  url: string;
  position: IFigurePosition;
  bounds: [number, number, number, number];
  motion: string;
  expression: string;
  createdAt: number;
}

type Figure = ProjectedGltfFigure;

interface ChoiceBranch {
  target: string;
  scene: boolean;
}

interface ChoicePreview {
  branches: ChoiceBranch[];
  figures: Map<string, Figure>;
  line: number;
  remaining: number;
}

interface ScenePreview {
  target: string;
  figures: Map<string, Figure>;
  remaining: number;
}

// Match ChooseOption.parse without importing its UI or evaluating either condition.
function choicePreview(sentence: ISentence, figures: Map<string, Figure>, line: number, remaining: number): ChoicePreview | undefined {
  const options = sentence.content.split(/(?<!\\)\|/);
  if (!options.length || options.length > 2) return;
  const branches: ChoiceBranch[] = [];
  for (const option of options) {
    const parts = option.trim().split('->');
    const main = parts.length > 1 ? parts[1] : parts[0];
    const target = main.split(/(?<!\\):/g)[1];
    if (!target || unresolved(target)) return;
    branches.push({ target, scene: /(?<!\\)\./.test(target) });
  }
  return { branches, figures: new Map(figures), line, remaining };
}

const identity = (figure: Figure) => JSON.stringify([figure.url, figure.position, figure.bounds]);
const isGltf = (url: string) => /\/config\.json(?:[?#].*)?$/.test(url);
const unresolved = (value: string) => /(?<!\\)\{/.test(value);
const boundaries = new Set([
  commandType.changeScene, commandType.callScene, commandType.return, commandType.jumpLabel,
  commandType.choose, commandType.chooseLabel, commandType.if, commandType.end,
  commandType.getUserInput, commandType.setVar,
]);

/** Predict only deterministic, committed figure states; never execute speculative scripts. */
export function planGltfPreloads(scene: IScene, start: number, state: IStageState, visit: string, limit = 20,
  projected?: Map<string, Figure>, allowChoice = true, firstBatchOnly = false) {
  const figures = new Map<string, Figure>();
  const seed = (key: string, url: string, position: IFigurePosition) => {
    const motion = state.live2dMotion.find(item => item.target === key);
    figures.set(key, { url, position, bounds: normalizeFigureBounds(motion?.overrideBounds),
      motion: motion?.motion ?? '', expression: state.live2dExpression.find(item => item.target === key)?.expression ?? '',
      createdAt: -1 });
  };
  for (const position of FIGURE_POSITIONS) seed(`fig-${position}`, state[figureStateKeyByPosition[position]], position);
  for (const figure of state.freeFigure) seed(figure.key, figure.name, figure.basePosition);
  if (projected) {
    figures.clear();
    for (const [key, figure] of projected) figures.set(key, { ...figure });
  }
  let committed = new Map(figures);
  const requests: GltfPreloadRequest[] = [];
  const batches: Array<Array<{ key: string; figure: ProjectedGltfFigure }>> = [];
  const named = new Map<string, { kind: 'motion' | 'expression'; name: string }>();
  const sentences: ISentence[] = [];
  let choice: ChoicePreview | undefined;
  let transition: ScenePreview | undefined;
  // The executor advances the cursor before commit, while the choice still blocks.
  const activeChoice = allowChoice && state.PerformList?.find(item => item.id === 'choose')?.script;
  if (activeChoice) {
    choice = choicePreview(activeChoice, figures, start, limit);
    return { requests, named: [...named.values()], sentences, choice, transition, batches, projectedFigures: new Map(figures) };
  }
  const collectCommittedFigures = () => {
    batches.push([...figures].filter(([, figure]) => isGltf(figure.url))
      .map(([key, figure]) => ({ key, figure: { ...figure } })));
    // A -next batch has one visible state; intermediate replacements need no instances.
    for (const [key, figure] of figures) {
      const old = committed.get(key);
      if (!isGltf(figure.url)) continue;
      for (const kind of ['motion', 'expression'] as const) {
        const name = figure[kind];
        if (name) named.set(`${kind}:${name}`, { kind, name });
      }
      if (!old || identity(old) !== identity(figure)) {
        requests.push({ url: figure.url, motion: figure.motion, expression: figure.expression,
          preloadId: JSON.stringify([visit, figure.createdAt, key, identity(figure)]) });
      }
    }
    committed = new Map(figures);
  };
  let meaningful = 0;
  for (let i = Math.max(0, start); i < scene.sentenceList.length && i < start + 2000; i++) {
    const sentence = scene.sentenceList[i];
    if (sentence.isLineBreakHolder || sentence.command === commandType.comment) continue;
    if (++meaningful > limit) break;
    const when = getStringArgByKey(sentence, 'when');
    if (when && when !== 'true') {
      if (when === 'false') continue;
      break;
    }
    if (sentence.command === commandType.choose) {
      collectCommittedFigures();
      if (allowChoice) choice = choicePreview(sentence, figures, i + 1, limit - meaningful);
      break;
    }
    if (sentence.command === commandType.changeScene) {
      collectCommittedFigures();
      if (allowChoice && sentence.content && !unresolved(sentence.content)) {
        transition = { target: sentence.content, figures: new Map(figures), remaining: limit - meaningful };
      }
      break;
    }
    if (boundaries.has(sentence.command)) break;
    sentences.push(sentence);
    if (sentence.command === commandType.changeFigure) {
      const url = getBooleanArgByKey(sentence, 'clear') || sentence.content === 'none' ? '' : sentence.content;
      const id = getStringArgByKey(sentence, 'id') ?? '';
      const position = getFigurePositionFromArgs(sentence) || 'center';
      const key = id || `fig-${position}`;
      const motion = getStringArgByKey(sentence, 'motion') ?? '';
      const expression = getStringArgByKey(sentence, 'expression') ?? '';
      const rawBounds = getStringArgByKey(sentence, 'bounds') ?? '';
      if ([url, id, motion, expression, rawBounds].some(unresolved)) break;
      const parsedBounds = rawBounds.split(',').map(Number);
      const bounds = rawBounds && parsedBounds.length === 4 && parsedBounds.every(value => !Number.isNaN(value))
        ? parsedBounds as [number, number, number, number] : undefined;
      const old = figures.get(key);
      const changed = !old || old.url !== url || old.position !== position
        || (!!rawBounds && JSON.stringify(normalizeFigureBounds(bounds)) !== JSON.stringify(old.bounds));
      figures.set(key, changed
        ? { url, position, bounds: normalizeFigureBounds(bounds), motion, expression, createdAt: i }
        : { ...old, motion: motion || bounds || getStringArgByKey(sentence, 'skin') ? motion : old.motion,
          expression: expression || old.expression, bounds: bounds ?? old.bounds });
    }
    if (getBooleanArgByKey(sentence, 'next')) continue;
    collectCommittedFigures();
    if (firstBatchOnly && requests.length) break;
  }
  return { requests, named: [...named.values()], sentences, choice, transition, batches, projectedFigures: new Map(figures) };
}

export type GltfPreloadPlan = ReturnType<typeof planGltfPreloads>;

/** A deterministic scene edge prepares only the next committed appearance batch. */
export function planGltfSceneTransition(plan: GltfPreloadPlan, targetScene: IScene,
  state: IStageState, targetVisit: string): GltfPreloadPlan | undefined {
  const transition = plan.transition;
  if (!transition || transition.remaining <= 0) return;
  return planGltfPreloads(targetScene, 0, state, targetVisit, transition.remaining,
    transition.figures, false, true);
}

/** Resolve one choice edge only. Each branch starts from its own projected figure state. */
export function planGltfChoiceBranch(plan: GltfPreloadPlan, branchIndex: number, targetScene: IScene,
  state: IStageState, visit: string): GltfPreloadPlan | undefined {
  const choice = plan.choice;
  const branch = choice?.branches[branchIndex];
  if (!choice || !branch || choice.remaining <= 0) return;
  let start = 0;
  if (!branch.scene) {
    start = -1;
    const current = targetScene.sentenceList[choice.line];
    if (current?.command === commandType.label && current.content === branch.target) start = choice.line;
    else targetScene.sentenceList.forEach((sentence, index) => {
      if (sentence.command === commandType.label && sentence.content === branch.target && index !== choice.line) start = index;
    });
    if (start < 0) return;
  }
  return planGltfPreloads(targetScene, start, state,
    `${visit}:choice:${choice.line}:${branchIndex}:${branch.target}`, choice.remaining, choice.figures, false,
    choice.branches.length > 1);
}

export function mergeGltfBranchPlans(base: GltfPreloadPlan, branches: (GltfPreloadPlan | undefined)[]): GltfPreloadPlan {
  const plans = branches.filter((plan): plan is GltfPreloadPlan => !!plan);
  const requests = [...base.requests];
  // Prioritize known appearances; after they commit the next plan can warm either branch.
  if (!base.requests.length || base.choice?.branches.length === 1 || base.transition) {
    for (let i = 0; plans.some(plan => i < plan.requests.length); i++) {
      for (const plan of plans) if (plan.requests[i]) requests.push(plan.requests[i]);
    }
  }
  const named = new Map(base.named.map(item => [`${item.kind}:${item.name}`, item]));
  for (const plan of plans) for (const item of plan.named) named.set(`${item.kind}:${item.name}`, item);
  return { ...base, requests, named: [...named.values()], sentences: [...base.sentences, ...plans.flatMap(plan => plan.sentences)] };
}

/** GPU lookahead stops at the first new appearance group, or at two predictable choice branches. */
export function planGltfBackgroundBatches(base: GltfPreloadPlan, branches: (GltfPreloadPlan | undefined)[]) {
  const first = (plan: GltfPreloadPlan) => {
    const appearances = new Set(plan.requests.map(request => JSON.stringify(JSON.parse(request.preloadId).slice(1))));
    return plan.batches.find(batch => batch.some(({key, figure}) =>
      appearances.has(JSON.stringify([figure.createdAt, key, identity(figure)]))));
  };
  const batch = first(base);
  if (batch) return [batch];
  return branches.filter((plan): plan is GltfPreloadPlan => !!plan).slice(0, 2)
    .map(first).filter((value): value is NonNullable<typeof value> => !!value);
}
