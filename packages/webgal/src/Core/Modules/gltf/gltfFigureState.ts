import type { ISentence } from '@/Core/controller/scene/sceneInterface';
import {
  FIGURE_POSITIONS,
  figureStateKeyByPosition,
  normalizeFigureBounds,
  type IFigurePosition,
  type IStageState,
} from '@/Core/Modules/stage/stageInterface';
import { getBooleanArgByKey, getFigurePositionFromArgs, getStringArgByKey } from '@/Core/util/getSentenceArg';
import type { FocusParam } from '@/Core/live2DCore';

export interface ProjectedGltfFigure {
  url: string;
  position: IFigurePosition;
  bounds: [number, number, number, number];
  motion: string;
  expression: string;
  createdAt: number;
  focus?: FocusParam;
}

export function seedGltfFigures(state: IStageState) {
  const figures = new Map<string, ProjectedGltfFigure>();
  const seed = (key: string, url: string, position: IFigurePosition) => {
    const motion = state.live2dMotion.find((item) => item.target === key);
    figures.set(key, {
      url,
      position,
      bounds: normalizeFigureBounds(motion?.overrideBounds),
      motion: motion?.motion ?? '',
      expression: state.live2dExpression.find((item) => item.target === key)?.expression ?? '',
      createdAt: -1,
    });
  };
  for (const position of FIGURE_POSITIONS) seed(`fig-${position}`, state[figureStateKeyByPosition[position]], position);
  for (const figure of state.freeFigure) seed(figure.key, figure.name, figure.basePosition);
  return figures;
}

/** Apply a deterministic changeFigure sentence; unresolved values leave the projection unchanged. */
export function projectGltfFigure(
  figures: Map<string, ProjectedGltfFigure>,
  sentence: ISentence,
  line: number,
): boolean {
  const url = getBooleanArgByKey(sentence, 'clear') || sentence.content === 'none' ? '' : sentence.content;
  const id = getStringArgByKey(sentence, 'id') ?? '';
  const position = getFigurePositionFromArgs(sentence) || 'center';
  const key = id || `fig-${position}`;
  const motion = getStringArgByKey(sentence, 'motion') ?? '';
  const expression = getStringArgByKey(sentence, 'expression') ?? '';
  const rawBounds = getStringArgByKey(sentence, 'bounds') ?? '';
  if ([url, id, motion, expression, rawBounds].some((value) => /(?<!\\)\{/.test(value))) return false;
  const parsedBounds = rawBounds.split(',').map(Number);
  const bounds =
    rawBounds && parsedBounds.length === 4 && parsedBounds.every((value) => !Number.isNaN(value))
      ? (parsedBounds as [number, number, number, number])
      : undefined;
  const old = figures.get(key);
  const changed =
    !old ||
    old.url !== url ||
    old.position !== position ||
    (!!rawBounds && JSON.stringify(normalizeFigureBounds(bounds)) !== JSON.stringify(old.bounds));
  figures.set(
    key,
    changed
      ? { url, position, bounds: normalizeFigureBounds(bounds), motion, expression, createdAt: line }
      : {
          ...old,
          motion: motion || bounds || getStringArgByKey(sentence, 'skin') ? motion : old.motion,
          expression: expression || old.expression,
          bounds: bounds ?? old.bounds,
        },
  );
  return true;
}
