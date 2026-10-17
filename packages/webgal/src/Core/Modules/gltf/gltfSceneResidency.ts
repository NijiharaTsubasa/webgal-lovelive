import type { IScene } from '@/Core/controller/scene/sceneInterface';
import { type IStageState } from '@/Core/Modules/stage/stageInterface';
import { WebGAL } from '@/Core/WebGAL';
import { registerSceneCharacterLoadingHooks, getCharacterLoadingMode } from '@/Core/util/sceneCharacterLoading';
import type { ProjectedGltfFigure } from './gltfFigureState';
import { planGltfSceneResidency, gltfFigureIdentity, type GltfSceneAppearance } from './gltfScenePlan';
import { characterOptions, GltfCharacterRuntime, preloadGltfNamedResources, areGltfNamedResourcesReady } from './gltfCharacter';
import { resolveFigureConfig } from './fixedGltfResources';
import { seedGltfFigures } from './gltfFigureState';
import { baseFocusParam } from '@/Core/live2DCore';

type Surface = import('webgal-lovelive-gltf-renderer').CharacterRenderSurface;
interface Resident { identity: string; runtime: GltfCharacterRuntime; actor: import('webgal-lovelive-gltf-renderer').OffscreenCharacter; slot: number; lastUse: number; warmedMotion?: string; warmedExpression?: string; backgroundReady?: boolean }
interface Residency { surfaces: Surface[]; residents: Resident[]; active: Set<Resident>; retired: boolean; mode: string; sceneUrl?: string; slotSchedule?: Map<number, Map<string, number | undefined>> }
let current: Residency | undefined;
const retired = new Set<Residency>();
const prepared = new Map<string, Resident>();
interface PreparationTask { run: () => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void }
const foregroundTasks: PreparationTask[] = [], backgroundTasks: PreparationTask[] = [];
let preparing = false;
let predictionWork: Promise<unknown> = Promise.resolve();
let prediction: AbortController | undefined;
let predictionSignature = '';
let predictedIdentities = new Set<string>();
const nativeConfigUrls = new Set<string>();
async function isGltfConfig(url: string) {
  if (nativeConfigUrls.has(url)) return false;
  const result = (await resolveFigureConfig(url)).gltf;
  if (!result) nativeConfigUrls.add(url);
  return result;
}
const namedInputs = (figure: ProjectedGltfFigure) => [
  ...(figure.motion ? [{ kind: 'motion' as const, name: figure.motion }] : []),
  ...(figure.expression ? [{ kind: 'expression' as const, name: figure.expression }] : []),
];
function drainPreparation() {
  if (preparing) return;
  const task = foregroundTasks.shift() ?? backgroundTasks.shift();
  if (!task) return;
  preparing = true;
  void Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
    preparing = false; drainPreparation();
  });
}
const serialize = <T>(operation: () => Promise<T>, background = false): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    (background ? backgroundTasks : foregroundTasks).push({run: operation, resolve, reject});
    drainPreparation();
  });
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
function plannedSlot(owner: Residency, identity: string) {
  if (!owner.sceneUrl || owner.sceneUrl !== WebGAL.sceneManager?.sceneData.currentScene.sceneUrl) return;
  const cursor = WebGAL.sceneManager.sceneData.currentSentenceId - 1;
  let lastLine = -Infinity, slots: Map<string, number | undefined> | undefined;
  for (const [line, schedule] of owner.slotSchedule ?? []) if (line <= cursor && line > lastLine) {
    lastLine = line; slots = schedule;
  }
  return slots?.get(identity);
}
function preferPlannedSlot(owner: Residency, identity: string, candidates: Resident[], slots?: Map<string, number | undefined>) {
  // A returning identity can have several preheated copies. Keep the planned
  // layout so its next neighbour does not collide with an unnecessarily chosen copy.
  const slot = slots ? slots.get(identity) : plannedSlot(owner, identity);
  return candidates.sort((a, b) => Number(b.slot === slot) - Number(a.slot === slot));
}
function selectStageResident(owner: Residency, key: string, figure: ProjectedGltfFigure, used: Set<number>, slots?: Map<string, number | undefined>) {
  const identity = gltfFigureIdentity(key, figure);
  const displayed = WebGAL.gameplay.pixiStage?.getStageObjByKey(key)?.gltfRuntime;
  const active = owner.residents.find(item => item.identity === identity && owner.active.has(item)
    && item.runtime === displayed && !used.has(item.slot));
  const slot = active ? undefined : slots ? slots.get(identity) : plannedSlot(owner, identity);
  return active ?? preferPlannedSlot(owner, identity, owner.residents.filter(item => item.identity === identity
    && !owner.active.has(item) && !used.has(item.slot)), slots).find(item => item.slot === slot
    || item.backgroundReady && item.warmedMotion === figure.motion && item.warmedExpression === figure.expression);
}
function stageFigures(state: IStageState) {
  return [...seedGltfFigures(state)].filter(([, figure]) => figure.url).map(([key, figure]) => ({ key, figure: {
    ...figure, focus: { ...baseFocusParam, ...state.live2dFocus.find(value => value.target === key)?.focus },
  } }));
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

async function prepareScene(scene: IScene, state: IStageState, signal: AbortSignal, startLine = 0) {
  if (current && !current.retired) {
    // Replan around the displayed actors, preserving their Pixi containers,
    // motion clocks and physics state across scene boundaries.
    const owner = current, previousMode = owner.mode;
    owner.mode = 'scene';
    try {
      await prepareRestore(scene, state, startLine, signal);
    } catch (error) {
      owner.mode = previousMode;
      throw error;
    }
    return;
  }
  const plan = planGltfSceneResidency(scene, state, startLine);
  const owner: Residency = { surfaces: [], residents: [], active: new Set(), retired: false, mode: 'scene', sceneUrl: scene.sceneUrl, slotSchedule: plan.slotSchedule };
  try {
    await preloadGltfNamedResources(plan.named);
    for (const { slot, key, figure, lastUse } of plan.appearances.values()) {
      assertCurrent(signal);
      if (!(await isGltfConfig(figure.url))) continue;
      const record = await addResident(owner, slot, key, figure, signal);
      record.lastUse = lastUse;
      // OffscreenCharacter.create has already prepared this exact initial state.
      record.backgroundReady = true;
      record.warmedMotion = figure.motion; record.warmedExpression = figure.expression;
    }
    assertCurrent(signal);
    const previous = current;
    current = owner;
    prepared.clear();
    retire(previous);
  } catch (error) { retire(owner); throw error; }
}

async function prepareRestore(scene: IScene, state: IStageState, line: number, signal: AbortSignal) {
  if (getCharacterLoadingMode() !== 'scene') {
    if (tryPrepareStage(state, signal) || await prepareDisplayedStage(state, signal)) return;
    return prepareStage(state, signal);
  }
  const owner = current;
  if (!owner || owner.retired || owner.mode !== 'scene') {
    await prepareScene(scene, state, signal, line);
    return prepareStage(state, signal);
  }
  if (owner.sceneUrl === scene.sceneUrl && scene.sceneUrl === WebGAL.sceneManager.sceneData.currentScene.sceneUrl
      && line === WebGAL.sceneManager.sceneData.currentSentenceId) {
    const displayed = [...owner.active].filter(record => record.runtime.isActive);
    const targets = stageFigures(state).filter(({figure}) => /\/config\.json(?:[?#].*)?$/.test(figure.url)
      && !nativeConfigUrls.has(figure.url));
    const unchanged = targets.length === displayed.length && targets.every(({key, figure}) => displayed.some(record =>
      record.identity === gltfFigureIdentity(key, figure)
      && record.runtime === WebGAL.gameplay.pixiStage?.getStageObjByKey(key)?.gltfRuntime
      && record.runtime.isReadyFor(figure.motion, figure.expression)));
    // A same-line, unchanged restore can keep the preheated future layout;
    // reseeding it from a different free-figure order would shuffle contexts.
    if (unchanged && tryPrepareStage(state, signal)) return;
  }
  const plan = planGltfSceneResidency(scene, state, line);
  const originals = new Map(owner.residents.map(record => [record, record.lastUse]));
  const originalSurfaces = new Set(owner.surfaces);
  const originalUrl = owner.sceneUrl;
  const originalSchedule = owner.slotSchedule;
  const displayedBeforeRestore = [...owner.active].filter(record => record.runtime.isActive);
  const lastUses = new Map<Resident, number>();
  const slotMapping = new Map<number, number>(), used = new Set<number>();
  // Rebind plan slots to existing contexts, preferring the currently displayed actor.
  const groups = new Map<number, GltfSceneAppearance[]>();
  for (const appearance of plan.appearances.values()) {
    const group = groups.get(appearance.slot) ?? [];
    group.push(appearance); groups.set(appearance.slot, group);
  }
  try {
    await preloadGltfNamedResources(plan.named);
    assertCurrent(signal);
    for (const [slot, group] of groups) {
      const candidates = owner.residents.filter(record => !used.has(record.slot) && record.runtime.isReady
        && group.some(({key, figure}) => record.identity === gltfFigureIdentity(key, figure)));
      const preferred = candidates.find(record => owner.active.has(record) && record.runtime.isActive) ?? candidates[0];
      if (preferred) { slotMapping.set(slot, preferred.slot); used.add(preferred.slot); }
    }
    for (const slot of groups.keys()) if (!slotMapping.has(slot)) {
      let actual = 0;
      while (used.has(actual) || [...owner.active].some(record => record.slot === actual)) actual++;
      slotMapping.set(slot, actual); used.add(actual);
    }
    // Protect retained residents against the old playback cursor while rewinding.
    for (const record of owner.residents) record.lastUse = Infinity;
    for (const {slot, key, figure, lastUse} of plan.appearances.values()) {
      assertCurrent(signal);
      const actual = slotMapping.get(slot)!;
      const identity = gltfFigureIdentity(key, figure);
      let record = owner.residents.find(item => item.identity === identity && item.slot === actual && item.runtime.isReady);
      if (!record && await isGltfConfig(figure.url)) {
        // Exit animations can retain older records on this slot. Pause its
        // actual occupants, not merely the first retained record.
        const active = [...owner.active].filter(item => item.slot === actual && item.runtime.isActive);
        for (const record of active) record.runtime.suspend();
        owner.surfaces[actual]?.deactivate();
        try {
          record = await addResident(owner, actual, key, figure, signal);
          record.backgroundReady = true;
          record.warmedMotion = figure.motion; record.warmedExpression = figure.expression;
        } finally {
          for (const record of active) if (owner.active.has(record)) {
            owner.surfaces[actual].activate(record.actor); record.runtime.activate(); record.runtime.update(0);
          }
        }
      }
      if (record) lastUses.set(record, Math.max(lastUses.get(record) ?? -1, lastUse));
    }
    assertCurrent(signal);
    const mappedSchedule = new Map([...plan.slotSchedule].map(([line, slots]) => [line,
      new Map([...slots].map(([identity, slot]) => [identity, slot === undefined ? undefined : slotMapping.get(slot)]))]));
    // The global scene cursor is published only after this preparation commits.
    // Use the restored layout now, rather than selecting copies from the old cursor.
    const restoredSlots = mappedSchedule.get(line - 1) ?? new Map<string, number | undefined>();
    if (!tryPrepareStage(state, signal, restoredSlots) && !await prepareDisplayedStage(state, signal, restoredSlots)) {
      await prepareStage(state, signal, restoredSlots);
    }
    assertCurrent(signal);
    owner.sceneUrl = scene.sceneUrl;
    owner.slotSchedule = mappedSchedule;
    for (const record of [...owner.residents]) {
      record.lastUse = lastUses.get(record) ?? line - 1;
      if (!lastUses.has(record) && !owner.active.has(record) && prepared.get(record.identity) !== record) releaseResident(owner, record);
    }
  } catch (error) {
    prepared.clear(); owner.sceneUrl = originalUrl; owner.slotSchedule = originalSchedule;
    for (const record of [...owner.residents]) {
      if (originals.has(record)) record.lastUse = originals.get(record)!;
      else releaseResident(owner, record);
    }
    owner.surfaces.forEach((surface, slot) => {
      if (surface && !originalSurfaces.has(surface) && !owner.residents.some(record => record.slot === slot)) {
        surface.dispose(); delete owner.surfaces[slot];
      }
    });
    for (const active of displayedBeforeRestore) if (owner.active.has(active)) {
      owner.surfaces[active.slot].activate(active.actor); active.runtime.activate(); active.runtime.update(0);
    }
    throw error;
  }
}

async function prepareStage(state: IStageState, signal: AbortSignal, slots?: Map<string, number | undefined>) {
  const figures = stageFigures(state);
  const targets = [];
  for (const entry of figures) {
    if (!/\/config\.json(?:[?#].*)?$/.test(entry.figure.url)) continue;
    if (await isGltfConfig(entry.figure.url)) targets.push(entry);
    assertCurrent(signal);
  }
  const previous = current;
  const owner = current && !current.retired ? current
    : { surfaces: [], residents: [], active: new Set(), retired: false, mode: getCharacterLoadingMode() } as Residency;
  const originalResidents = new Set(owner.residents);
  const originalSurfaces = new Set(owner.surfaces);
  const displayedBeforePreparation = [...owner.active].filter(record => record.runtime.isActive);
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
    [key, preferPlannedSlot(owner, gltfFigureIdentity(key, figure), owner.residents.filter(record => record.identity === gltfFigureIdentity(key, figure)
      && !owner.active.has(record) && !used.has(record.slot)), slots)]));
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
      if (!record.runtime.isReady) await record.runtime.prepare();
      if (!record.runtime.isReadyFor(figure.motion, figure.expression)) await preloadGltfNamedResources(namedInputs(figure));
      continue;
    }
    if (!owner.active.has(record)) { record.runtime.activate(); record.runtime.suspend(); }
    record.runtime.setFocus(figure.focus ?? baseFocusParam);
    if (!record.backgroundReady || !record.runtime.isReadyFor(figure.motion, figure.expression)
        || record.warmedMotion !== figure.motion || record.warmedExpression !== figure.expression) {
      record.runtime.setMotion(figure.motion);
      record.runtime.setExpression(figure.expression);
      await record.runtime.prepare();
      record.warmedMotion = figure.motion; record.warmedExpression = figure.expression;
      record.backgroundReady = true;
    }
    prepared.set(record.identity, record);
  }
  assertCurrent(signal);
  owner.mode = getCharacterLoadingMode();
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
      for (const active of displayedBeforePreparation) if (owner.active.has(active)) {
        owner.surfaces[active.slot].activate(active.actor); active.runtime.activate(); active.runtime.update(0);
      }
    }
    throw error;
  }
}

/** No file lookup, Promise queue, GPU work, or mutation of displayed commands. */
function tryPrepareStage(state: IStageState, signal: AbortSignal, slots?: Map<string, number | undefined>) {
  if (signal.aborted) return false;
  const targets = stageFigures(state).filter(({figure}) => /\/config\.json(?:[?#].*)?$/.test(figure.url)
    && !nativeConfigUrls.has(figure.url));
  if (!targets.length) {
    if (current) for (const record of [...current.residents]) {
      if (!current.active.has(record) && !prepared.has(record.identity) && pastLastUse(current, record)) releaseResident(current, record);
    }
    return true;
  }
  const owner = current;
  if (!owner || owner.retired || owner.mode !== getCharacterLoadingMode()) return false;
  const used = new Set<number>();
  const held: Array<{record: Resident; figure: ProjectedGltfFigure}> = [];
  for (const {key, figure} of targets) {
    const record = selectStageResident(owner, key, figure, used, slots);
    if (!record || !record.runtime.isReady) return false;
    if (!owner.active.has(record) && (!record.backgroundReady || record.warmedMotion !== figure.motion
        || record.warmedExpression !== figure.expression)) return false;
    if (!record.runtime.isReadyFor(figure.motion, figure.expression)
        && !areGltfNamedResourcesReady(namedInputs(figure))) return false;
    used.add(record.slot);
    if (!owner.active.has(record)) held.push({record, figure});
  }
  // Only publish reservations after the whole target group has passed.
  for (const {record, figure} of held) {
    record.runtime.activate(); record.runtime.suspend();
    record.runtime.setFocus(figure.focus ?? baseFocusParam);
    prepared.set(record.identity, record);
  }
  signal.addEventListener('abort', () => {
    for (const {record} of held) if (prepared.get(record.identity) === record) {
      prepared.delete(record.identity);
      if (owner.mode === 'on-demand' && !owner.active.has(record) && !predictedIdentities.has(record.identity)
          && owner.residents.includes(record)) releaseResident(owner, record);
    }
  }, {once:true});
  return true;
}

async function prepareDisplayedStage(state: IStageState, signal: AbortSignal, slots?: Map<string, number | undefined>) {
  const owner = current;
  if (!owner || owner.retired || owner.mode !== getCharacterLoadingMode()) return false;
  const named: Array<{kind: 'motion' | 'expression'; name: string}> = [];
  const held: Resident[] = [];
  const used = new Set<number>();
  const rollback = () => { for (const record of held) if (prepared.get(record.identity) === record) {
    prepared.delete(record.identity);
    if (owner.mode === 'on-demand' && !owner.active.has(record) && !predictedIdentities.has(record.identity)
        && owner.residents.includes(record)) releaseResident(owner, record);
  } };
  try {
  for (const {key, figure} of stageFigures(state)) {
    if (!/\/config\.json(?:[?#].*)?$/.test(figure.url)) continue;
    const identity = gltfFigureIdentity(key, figure);
    const record = selectStageResident(owner, key, figure, used, slots);
    if (!record || !record.runtime.isReady || !owner.active.has(record)
        && (!record.backgroundReady || record.warmedMotion !== figure.motion || record.warmedExpression !== figure.expression)) {
      if (await isGltfConfig(figure.url)) { rollback(); return false; }
      continue;
    }
    used.add(record.slot);
    if (!owner.active.has(record)) {
      record.runtime.setFocus(figure.focus ?? baseFocusParam);
      held.push(record); prepared.set(identity, record);
    }
    if (!record.runtime.isReadyFor(figure.motion, figure.expression)) named.push(...namedInputs(figure));
  }
  // Ready actors do not depend on an unrelated future actor's GPU preparation.
  if (named.length) await preloadGltfNamedResources(named);
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
  if (signature === predictionSignature && !prediction?.signal.aborted) return predictionWork;
  predictionSignature = signature;
  predictedIdentities = new Set(batches.flatMap(batch => batch.map(({key, figure}) => gltfFigureIdentity(key, figure))));
  prediction?.abort();
  const controller = prediction = new AbortController();
  const run = async () => {
    if (controller.signal.aborted || getCharacterLoadingMode() !== 'on-demand') return;
    const wanted = new Map(batches.flatMap(batch => batch.map(({key, figure}) =>
      [gltfFigureIdentity(key, figure), {key, figure}] as const)));
    const owner = await serialize(async () => {
      if (controller.signal.aborted || getCharacterLoadingMode() !== 'on-demand') return;
      const owner = current ?? (current = { surfaces: [], residents: [], active: new Set(), retired: false, mode: 'on-demand' });
      if (owner.mode !== 'on-demand') return;
      for (const record of [...owner.residents]) {
        if (!owner.active.has(record) && prepared.get(record.identity) !== record && !wanted.has(record.identity)) releaseResident(owner, record);
      }
      return owner;
    }, true);
    if (!owner) return;
    const created = new Set<Resident>();
    try {
      for (const [identity, {key, figure}] of wanted) {
        // A current stage group can run between speculative actor preparations.
        await serialize(async () => {
          assertCurrent(controller.signal);
          if (owner !== current || owner.retired) return;
          if (!(await isGltfConfig(figure.url))) return;
          assertCurrent(controller.signal);
          // Displayed instances keep their current commands and physics state.
          if (owner.residents.some(record => record.identity === identity)) return;
          let slot = 0;
          while (owner.residents.some(record => record.slot === slot)) slot++;
          const record = await addResident(owner, slot, key, figure, controller.signal);
          created.add(record);
          await record.runtime.prepare();
          record.warmedMotion = figure.motion; record.warmedExpression = figure.expression;
          record.backgroundReady = true;
          assertCurrent(controller.signal);
        }, true);
      }
    } catch (error) {
      for (const record of created) if (owner.residents.includes(record) && !owner.active.has(record)
          && prepared.get(record.identity) !== record) releaseResident(owner, record);
      owner.surfaces.forEach((surface, slot) => {
        if (!owner.residents.some(record => record.slot === slot)) { surface?.dispose(); delete owner.surfaces[slot]; }
      });
      if (prediction === controller) predictionSignature = '';
      if (!controller.signal.aborted) throw error;
    }
  };
  predictionWork = run();
  return predictionWork;
}

/** A prepared actor attaches synchronously so a committed group starts together. */
export function takePreparedGltfCharacter(key: string, url: string, position: ProjectedGltfFigure['position'], bounds: ProjectedGltfFigure['bounds']) {
  const identity = gltfFigureIdentity(key, { url, position, bounds } as ProjectedGltfFigure);
  const record = prepared.get(identity);
  if (!record || !current?.residents.includes(record)) return;
  prepared.delete(identity);
  record.backgroundReady = false;
  for (const active of current.active) if (active !== record && active.slot === record.slot) {
    active.runtime.suspend(); current.surfaces[record.slot].deactivate(active.actor);
  }
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
  tryPrepareStage,
  prepareStage: async (state, signal) => {
    if (tryPrepareStage(state, signal)) return;
    if (await prepareDisplayedStage(state, signal)) return;
    return serialize(() => prepareStage(state, signal));
  },
  prepareScene: (scene, state, signal) => { prediction?.abort(); return serialize(() => prepareScene(scene, state, signal)); },
  prepareRestore: (scene, state, line, signal) => {
    prediction?.abort(); predictionSignature = '';
    return serialize(() => prepareRestore(scene, state, line, signal));
  },
  releaseScene,
});
