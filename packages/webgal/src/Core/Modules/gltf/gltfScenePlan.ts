import { commandType, type IScene } from '@/Core/controller/scene/sceneInterface';
import { type IStageState } from '@/Core/Modules/stage/stageInterface';
import { getBooleanArgByKey, getStringArgByKey } from '@/Core/util/getSentenceArg';
import { seedGltfFigures, projectGltfFigure } from './gltfFigureState';
import type { ProjectedGltfFigure } from './gltfFigureState';

export const gltfFigureIdentity = (key: string, figure: ProjectedGltfFigure) =>
  JSON.stringify([key, figure.url, figure.position, figure.bounds]);

export interface GltfSceneAppearance {
  slot: number;
  key: string;
  figure: ProjectedGltfFigure;
  /** Last script line that can display this resident; Infinity prevents early release. */
  lastUse: number;
}

const dynamic = (value: string) => /(?<!\\)\{/.test(value);
const gltfUrl = (value: string) => /\/config\.json(?:[?#].*)?$/.test(value);
const MAX_SCENE_STATES = 20000;

/** Traverse static in-scene paths without executing variables or visiting other scenes. */
export function planGltfSceneResidency(scene: IScene, state: IStageState) {
  const lines = scene.sentenceList;
  const labels = new Map<string, number>();
  lines.forEach((sentence, line) => {
    if (sentence.command === commandType.label && !dynamic(sentence.content)) labels.set(sentence.content, line);
  });
  type Figures = Map<string, ProjectedGltfFigure>;
  interface PathState { line: number; figures: Figures; slots: Map<string, number> }
  const seed = seedGltfFigures(state);
  const queue: PathState[] = lines.length ? [{ line: 0, figures: seed, slots: new Map() }] : [];
  const visited = new Set<string>();
  const appearances = new Map<string, GltfSceneAppearance>();
  const named = new Map<string, { kind: 'motion' | 'expression'; name: string }>();
  const batches: Array<Array<{ key: string; figure: ProjectedGltfFigure }>> = [];
  const runtimeGateLines = new Set<number>();
  let capacity = 0, unsafeRelease = false, truncated = false;
  const enqueue = (line: number, figures: Figures, slots: Map<string, number>) => {
    if (line >= 0 && line < lines.length) queue.push({ line, figures: new Map(figures), slots: new Map(slots) });
  };
  const commit = (line: number, path: PathState) => {
    const batch = [...path.figures].filter(([, figure]) => gltfUrl(figure.url) && !dynamic(figure.url))
      .map(([key, figure]) => ({ key, figure: { ...figure } }));
    batches.push(batch);
    const assigned = new Map<string, number>(), used = new Set<number>();
    for (const { key, figure } of batch) {
      const identity = gltfFigureIdentity(key, figure), slot = path.slots.get(identity);
      if (slot !== undefined) { assigned.set(identity, slot); used.add(slot); }
    }
    for (const { key, figure } of batch) {
      const identity = gltfFigureIdentity(key, figure);
      let slot = assigned.get(identity);
      if (slot === undefined) {
        slot = 0; while (used.has(slot)) slot++;
        assigned.set(identity, slot); used.add(slot);
      }
      capacity = Math.max(capacity, slot + 1);
      const id = `${slot}:${identity}`, previous = appearances.get(id);
      appearances.set(id, { slot, key, figure: previous?.figure ?? figure, lastUse: Math.max(previous?.lastUse ?? -1, line) });
      for (const kind of ['motion', 'expression'] as const) {
        const name = figure[kind];
        if (name && !dynamic(name)) named.set(`${kind}:${name}`, { kind, name });
      }
    }
    path.slots = assigned;
  };
  const target = (name: string, path: PathState, line: number) => {
    if (!name || dynamic(name)) {
      runtimeGateLines.add(line); unsafeRelease = true;
      // Continue discovery after the uncertain edge; actual execution uses the stage gate.
      enqueue(line + 1, path.figures, path.slots); return;
    }
    const destination = labels.get(name);
    if (destination === undefined) { enqueue(line + 1, path.figures, path.slots); return; }
    if (destination <= line) unsafeRelease = true;
    enqueue(destination, path.figures, path.slots);
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (visited.size >= MAX_SCENE_STATES) { truncated = true; unsafeRelease = true; break; }
    const path = queue[cursor], line = path.line, sentence = lines[line];
    const key = JSON.stringify([line, [...path.figures].sort(([a], [b]) => a.localeCompare(b)), [...path.slots].sort(([a], [b]) => a.localeCompare(b))]);
    if (visited.has(key)) continue;
    visited.add(key);
    if (sentence.isLineBreakHolder || sentence.command === commandType.comment) { enqueue(line + 1, path.figures, path.slots); continue; }
    const when = getStringArgByKey(sentence, 'when');
    if (when === 'false') { enqueue(line + 1, path.figures, path.slots); continue; }
    if (when && when !== 'true') enqueue(line + 1, path.figures, path.slots);
    const command = sentence.command;
    if (command === commandType.jumpLabel || command === commandType.if) {
      // The supported conditional label syntax is jumpLabel -when. Legacy if
      // can supply an explicit label argument; an absent target remains gated.
      target(command === commandType.if ? getStringArgByKey(sentence, 'label') ?? '' : sentence.content, path, line);
      if (command === commandType.if) enqueue(line + 1, path.figures, path.slots);
      continue;
    }
    if (command === commandType.choose || command === commandType.chooseLabel) {
      commit(line, path);
      const options = sentence.content.split(/(?<!\\)\|/);
      if (!options.length || options.length > 2) {
        runtimeGateLines.add(line); unsafeRelease = true;
        enqueue(line + 1, path.figures, path.slots); continue;
      }
      for (const option of options) {
        const parts = option.trim().split('->'), main = parts.length > 1 ? parts[1] : parts[0];
        const name = main.split(/(?<!\\):/)[1];
        if (name && !dynamic(name) && /(?<!\\)\./.test(name)) continue;
        target(name ?? '', path, line);
      }
      continue;
    }
    if (command === commandType.changeScene || command === commandType.return || command === commandType.end) {
      commit(line, path); continue;
    }
    if (command === commandType.callScene) { runtimeGateLines.add(line); unsafeRelease = true; }
    if (command === commandType.changeFigure) {
      const id = getStringArgByKey(sentence, 'id') ?? '';
      if (dynamic(id) || dynamic(sentence.content)) {
        runtimeGateLines.add(line); unsafeRelease = true;
      } else {
        let uncertain = false;
        const args = sentence.args.filter(arg => {
          if (arg.key === 'when') return false;
          if (typeof arg.value === 'string' && dynamic(arg.value)) { uncertain = true; return false; }
          return true;
        });
        if (uncertain) { runtimeGateLines.add(line); unsafeRelease = true; }
        projectGltfFigure(path.figures, { ...sentence, args }, line);
      }
    }
    // Variable/input statements only affect evaluation at runtime, not static figure discovery.
    if (command === commandType.getUserInput || !getBooleanArgByKey(sentence, 'next')) commit(line, path);
    if (line === lines.length - 1) commit(line, path);
    enqueue(line + 1, path.figures, path.slots);
  }
  if (unsafeRelease) for (const appearance of appearances.values()) appearance.lastUse = Infinity;
  const slotLastUse = new Map<number, number>();
  for (const appearance of appearances.values()) slotLastUse.set(appearance.slot, Math.max(slotLastUse.get(appearance.slot) ?? -1, appearance.lastUse));
  return { capacity, appearances, named: [...named.values()], batches, runtimeGateLines: [...runtimeGateLines], slotLastUse,
    canRelease: !unsafeRelease, truncated };
}
