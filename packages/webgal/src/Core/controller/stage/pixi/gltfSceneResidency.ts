import type { IScene } from '@/Core/controller/scene/sceneInterface';
import { FIGURE_POSITIONS, figureStateKeyByPosition, normalizeFigureBounds, type IStageState } from '@/Core/Modules/stage/stageInterface';
import { WebGAL } from '@/Core/WebGAL';
import { registerSceneCharacterLoadingHooks, getCharacterLoadingMode } from '@/Core/util/sceneCharacterLoading';
import type { ProjectedGltfFigure } from '@/Core/util/prefetcher/gltfPrefetchPlan';
import { planGltfSceneResidency, gltfFigureIdentity } from '@/Core/util/prefetcher/gltfScenePlan';
import { characterOptions, GltfCharacterRuntime, preloadGltfNamedResources } from './gltfCharacter';
import { resolveFigureConfig } from './fixedGltfResources';
import { baseFocusParam } from '@/Core/live2DCore';

type Surface = import('webgal-lovelive-gltf-renderer').CharacterRenderSurface;
interface Resident { identity: string; runtime: GltfCharacterRuntime; actor: import('webgal-lovelive-gltf-renderer').OffscreenCharacter; slot: number; lastUse: number; warmedMotion?: string; warmedExpression?: string; backgroundReady?: boolean }
interface Residency { surfaces: Surface[]; residents: Resident[]; active: Set<Resident>; retired: boolean; mode: string; sceneUrl?: string }
let current: Residency | undefined;
const retired = new Set<Residency>();
const prepared = new Map<string, Resident>();
let work: Promise<unknown> = Promise.resolve();
let prediction: AbortController | undefined;
let predictionSignature = '';
let predictedIdentities = new Set<string>();
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = work.then(operation, operation);
  work = result.catch(() => undefined);
  return result;
};
const assertCurrent = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };

function destroy(residency: Residency) {
  if (residency.active.size) return;
  for (const surface of residency.surfaces) surface?.dispose();
  residency.residents.length = 0;
  retired.delete(residency);
}
function retire(residency: Residency | undefined) {
  if (!residency) return;
  residency.retired = true;
  retired.add(residency);
  destroy(residency);
}
function releaseResident(owner: Residency, record: Resident) {
  record.actor.dispose();
  owner.residents = owner.residents.filter(item => item !== record);
  if (prepared.get(record.identity) === record) prepared.delete(record.identity);
  if (!owner.residents.some(item => item.slot === record.slot)) {
    owner.surfaces[record.slot]?.dispose(); delete owner.surfaces[record.slot];
  }
}
function pastLastUse(owner: Residency, record: Resident) {
  return !!owner.sceneUrl && owner.sceneUrl === WebGAL.sceneManager?.sceneData.currentScene.sceneUrl
    && record.lastUse < WebGAL.sceneManager.sceneData.currentSentenceId - 1;
}
function stageFigures(state: IStageState) {
  const entries = FIGURE_POSITIONS.map(position => ({ key: `fig-${position}`, url: state[figureStateKeyByPosition[position]], position }));
  entries.push(...state.freeFigure.map(item => ({ key: item.key, url: item.name, position: item.basePosition })));
  return entries.filter(item => item.url).map(item => ({ key: item.key, figure: {
    url: item.url, position: item.position,
    bounds: normalizeFigureBounds(state.live2dMotion.find(value => value.target === item.key)?.overrideBounds),
    motion: state.live2dMotion.find(value => value.target === item.key)?.motion ?? '',
    expression: state.live2dExpression.find(value => value.target === item.key)?.expression ?? '', createdAt: -1,
    focus: { ...baseFocusParam, ...state.live2dFocus.find(value => value.target === item.key)?.focus },
  } as ProjectedGltfFigure }));
}
async function addResident(owner: Residency, slot: number, key: string, figure: ProjectedGltfFigure, signal: AbortSignal) {
  const { OffscreenCharacter, CharacterRenderSurface } = await import('webgal-lovelive-gltf-renderer');
  const options = await characterOptions(figure.url, WebGAL.stageWidth, WebGAL.stageHeight);
  assertCurrent(signal);
  const surface = owner.surfaces[slot] ?? (owner.surfaces[slot] = new CharacterRenderSurface(options));
  const actor = await OffscreenCharacter.create({ ...options, motion: figure.motion, expression: figure.expression,
    focus: figure.focus, surface });
  if (signal.aborted) { actor.dispose(); assertCurrent(signal); }
  let record!: Resident;
  const runtime = new GltfCharacterRuntime(actor, figure, () => {
    owner.active.delete(record);
    surface.deactivate(actor);
    if (!owner.retired && (owner.mode === 'on-demand' || pastLastUse(owner, record))) releaseResident(owner, record);
    if (owner.retired) destroy(owner);
  });
  runtime.suspend();
  record = { identity: gltfFigureIdentity(key, figure), runtime, actor, slot, lastUse: Infinity };
  owner.residents.push(record);
  return record;
}

async function prepareScene(scene: IScene, state: IStageState, signal: AbortSignal) {
  const plan = planGltfSceneResidency(scene, state);
  const owner: Residency = { surfaces: [], residents: [], active: new Set(), retired: false, mode: 'scene', sceneUrl: scene.sceneUrl };
  try {
    await preloadGltfNamedResources(plan.named);
    for (const { slot, key, figure, lastUse } of plan.appearances.values()) {
      assertCurrent(signal);
      if (!(await resolveFigureConfig(figure.url)).gltf) continue;
      const record = await addResident(owner, slot, key, figure, signal);
      record.lastUse = lastUse;
    }
    assertCurrent(signal);
    const previous = current;
    current = owner;
    prepared.clear();
    retire(previous);
  } catch (error) { retire(owner); throw error; }
}

async function prepareStage(state: IStageState, signal: AbortSignal) {
  const figures = stageFigures(state);
  const targets = [];
  for (const entry of figures) {
    if (!/\/config\.json(?:[?#].*)?$/.test(entry.figure.url)) continue;
    if ((await resolveFigureConfig(entry.figure.url)).gltf) targets.push(entry);
    assertCurrent(signal);
  }
  const previous = current;
  const owner = current && current.mode === getCharacterLoadingMode() ? current
    : { surfaces: [], residents: [], active: new Set(), retired: false, mode: getCharacterLoadingMode() } as Residency;
  const originalResidents = new Set(owner.residents);
  const originalSurfaces = new Set(owner.surfaces);
  const used = new Set<number>();
  const selections: Array<{ record: Resident; figure: ProjectedGltfFigure }> = [];
  const reserved = new Map<string, Resident>();
  for (const { key, figure } of targets) {
    const displayed = WebGAL.gameplay.pixiStage?.getStageObjByKey(key)?.gltfRuntime;
    const record = owner.residents.find(item => item.identity === gltfFigureIdentity(key, figure)
      && owner.active.has(item) && item.runtime === displayed);
    if (record) { reserved.set(key, record); used.add(record.slot); }
  }
  const candidatesByKey = new Map(targets.filter(item => !reserved.has(item.key)).map(({ key, figure }) =>
    [key, owner.residents.filter(record => record.identity === gltfFigureIdentity(key, figure)
      && !owner.active.has(record) && !used.has(record.slot))]));
  const matched = new Map<string, Resident>();
  const slotKeys = new Map<number, string>();
  const match = (key: string, visited: Set<number>): boolean => {
    for (const record of candidatesByKey.get(key) ?? []) {
      if (visited.has(record.slot)) continue;
      visited.add(record.slot);
      const displaced = slotKeys.get(record.slot);
      if (!displaced || match(displaced, visited)) {
        slotKeys.set(record.slot, key); matched.set(key, record); return true;
      }
    }
    return false;
  };
  for (const key of candidatesByKey.keys()) match(key, new Set());
  for (const record of matched.values()) used.add(record.slot);
  try {
  for (const { key, figure } of targets) {
    const identity = gltfFigureIdentity(key, figure);
    const displayed = WebGAL.gameplay.pixiStage?.getStageObjByKey(key)?.gltfRuntime;
    const candidates = owner.residents.filter(item => item.identity === identity && !used.has(item.slot)
      && (!owner.active.has(item) || displayed === item.runtime));
    let record = reserved.get(key) ?? matched.get(key) ?? candidates.find(item => owner.active.has(item)) ?? candidates[0];
    if (!record) {
      let slot = 0; while (used.has(slot)) slot++;
      for (const active of owner.active) if (active.slot === slot) { active.runtime.suspend(); owner.surfaces[slot].deactivate(active.actor); }
      record = await addResident(owner, slot, key, figure, signal);
    }
    used.add(record.slot);
    selections.push({ record, figure });
  }
  // Preserve the previous uploaded Pixi picture while the borrowed canvas is prepared.
  for (const active of owner.active) if (!selections.some(item => item.record === active)) {
    active.runtime.suspend(); owner.surfaces[active.slot].deactivate(active.actor);
  }
  for (const { record, figure } of selections) {
    assertCurrent(signal);
    if (owner.active.has(record)) {
      await preloadGltfNamedResources([
        ...(figure.motion ? [{ kind: 'motion' as const, name: figure.motion }] : []),
        ...(figure.expression ? [{ kind: 'expression' as const, name: figure.expression }] : []),
      ]);
      continue;
    }
    if (!owner.active.has(record)) { record.runtime.activate(); record.runtime.suspend(); }
    record.runtime.setFocus(figure.focus ?? baseFocusParam);
    if (!record.backgroundReady || record.warmedMotion !== figure.motion || record.warmedExpression !== figure.expression) {
      record.runtime.setMotion(figure.motion);
      record.runtime.setExpression(figure.expression);
      await record.runtime.prepare();
      record.warmedMotion = figure.motion; record.warmedExpression = figure.expression;
    }
    prepared.set(record.identity, record);
  }
  assertCurrent(signal);
  current = owner;
  if (previous !== owner) retire(previous);
  for (const record of [...owner.residents]) {
    if (!owner.active.has(record) && !selections.some(item => item.record === record)
      && pastLastUse(owner, record)) releaseResident(owner, record);
  }
  } catch (error) {
    prepared.clear();
    if (owner !== previous) retire(owner);
    else {
      for (const record of [...owner.residents]) if (!originalResidents.has(record)) {
        record.actor.dispose(); owner.residents = owner.residents.filter(item => item !== record);
      }
      owner.surfaces.forEach((surface, slot) => {
        if (!originalSurfaces.has(surface) && !owner.residents.some(item => item.slot === slot)) {
          surface?.dispose(); delete owner.surfaces[slot];
        }
      });
      for (const active of owner.active) {
        owner.surfaces[active.slot].activate(active.actor); active.runtime.activate(); active.runtime.update(0);
      }
    }
    throw error;
  }
}

async function prepareDisplayedStage(state: IStageState, signal: AbortSignal) {
  const owner = current;
  if (!owner || owner.retired || owner.mode !== 'on-demand' || owner.mode !== getCharacterLoadingMode()) return false;
  const named: Array<{kind: 'motion' | 'expression'; name: string}> = [];
  const held: Resident[] = [];
  const used = new Set<number>();
  const rollback = () => { for (const record of held) if (prepared.get(record.identity) === record) {
    prepared.delete(record.identity);
    if (!owner.active.has(record) && !predictedIdentities.has(record.identity) && owner.residents.includes(record)) releaseResident(owner, record);
  } };
  try {
  for (const {key, figure} of stageFigures(state)) {
    if (!/\/config\.json(?:[?#].*)?$/.test(figure.url)) continue;
    const displayed = WebGAL.gameplay.pixiStage?.getStageObjByKey(key)?.gltfRuntime;
    const identity = gltfFigureIdentity(key, figure);
    const record = owner.residents.find(record => !used.has(record.slot) && record.identity === identity
      && (owner.active.has(record) ? record.runtime === displayed
        : record.backgroundReady && record.warmedMotion === figure.motion && record.warmedExpression === figure.expression));
    if (!record) {
      if ((await resolveFigureConfig(figure.url)).gltf) { rollback(); return false; }
      continue;
    }
    used.add(record.slot);
    if (!owner.active.has(record)) {
      record.runtime.setFocus(figure.focus ?? baseFocusParam);
      held.push(record); prepared.set(identity, record);
    }
    if (figure.motion) named.push({kind: 'motion', name: figure.motion});
    if (figure.expression) named.push({kind: 'expression', name: figure.expression});
  }
  // Ready actors do not depend on an unrelated future actor's GPU preparation.
  await preloadGltfNamedResources(named);
  assertCurrent(signal);
  if (current !== owner || owner.retired || held.some(record => !owner.residents.includes(record))) {
    rollback(); return false;
  }
  signal.addEventListener('abort', rollback, {once: true});
  return true;
  } catch (error) { rollback(); throw error; }
}

/** Warm the next reachable groups without publishing loading state or touching displayed canvases. */
export function prewarmGltfPredictions(batches: Array<Array<{ key: string; figure: ProjectedGltfFigure }>>) {
  const signature = JSON.stringify([getCharacterLoadingMode(), batches]);
  if (signature === predictionSignature && !prediction?.signal.aborted) return work.then(() => undefined);
  predictionSignature = signature;
  predictedIdentities = new Set(batches.flatMap(batch => batch.map(({key, figure}) => gltfFigureIdentity(key, figure))));
  prediction?.abort();
  const controller = prediction = new AbortController();
  return serialize(async () => {
    if (controller.signal.aborted || getCharacterLoadingMode() !== 'on-demand') return;
    const owner = current ?? (current = { surfaces: [], residents: [], active: new Set(), retired: false, mode: 'on-demand' });
    if (owner.mode !== 'on-demand') return;
    const wanted = new Map(batches.flatMap(batch => batch.map(({key, figure}) =>
      [gltfFigureIdentity(key, figure), {key, figure}] as const)));
    for (const record of [...owner.residents]) {
      if (!owner.active.has(record) && prepared.get(record.identity) !== record && !wanted.has(record.identity)) releaseResident(owner, record);
    }
    try {
      for (const [identity, {key, figure}] of wanted) {
        assertCurrent(controller.signal);
        if (!(await resolveFigureConfig(figure.url)).gltf) continue;
        assertCurrent(controller.signal);
        // Displayed instances keep their current commands and physics state.
        if (owner.residents.some(record => record.identity === identity)) continue;
        let slot = 0;
        while (owner.residents.some(record => record.slot === slot)) slot++;
        const record = await addResident(owner, slot, key, figure, controller.signal);
        await record.runtime.prepare();
        record.warmedMotion = figure.motion; record.warmedExpression = figure.expression;
        record.backgroundReady = true;
        assertCurrent(controller.signal);
      }
    } catch (error) {
      for (const record of [...owner.residents]) if (!owner.active.has(record) && prepared.get(record.identity) !== record) releaseResident(owner, record);
      owner.surfaces.forEach((surface, slot) => {
        if (!owner.residents.some(record => record.slot === slot)) { surface?.dispose(); delete owner.surfaces[slot]; }
      });
      if (prediction === controller) predictionSignature = '';
      if (!controller.signal.aborted) throw error;
    }
  });
}

/** A prepared actor attaches synchronously so a committed group starts together. */
export function takePreparedGltfCharacter(key: string, url: string, position: ProjectedGltfFigure['position'], bounds: ProjectedGltfFigure['bounds']) {
  const identity = gltfFigureIdentity(key, { url, position, bounds } as ProjectedGltfFigure);
  const record = prepared.get(identity);
  if (!record || !current?.residents.includes(record)) return;
  prepared.delete(identity);
  record.backgroundReady = false;
  current.active.add(record);
  current.surfaces[record.slot].activate(record.actor);
  record.runtime.activate();
  record.runtime.update(0);
  return record.runtime;
}
export function hasPreparedGltfCharacter(key: string, url: string, position: ProjectedGltfFigure['position'], bounds: ProjectedGltfFigure['bounds']) {
  return prepared.has(gltfFigureIdentity(key, { url, position, bounds } as ProjectedGltfFigure));
}

function releaseScene() {
  prediction?.abort();
  predictionSignature = '';
  predictedIdentities.clear();
  prepared.clear();
  const owner = current;
  current = undefined;
  if (!owner) return;
  for (const record of [...owner.residents]) if (!owner.active.has(record)) releaseResident(owner, record);
  retire(owner);
}
registerSceneCharacterLoadingHooks({
  prepareStage: async (state, signal) => {
    if (await prepareDisplayedStage(state, signal)) return;
    return serialize(() => prepareStage(state, signal));
  },
  prepareScene: (scene, state, signal) => { prediction?.abort(); return serialize(() => prepareScene(scene, state, signal)); },
  releaseScene,
});
