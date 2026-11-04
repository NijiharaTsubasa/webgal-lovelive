import { offlineExportHost } from '@/Core/util/offlineExportHost';
import { WebGAL } from '@/Core/WebGAL';
import { stageStateManager } from '@/Core/Modules/stage/stageStateManager';
import { sceneParser } from '@/Core/parser/sceneParser';
import { switchAuto, stopAuto } from '@/Core/controller/gamePlay/autoPlay';
import { nextSentence } from '@/Core/controller/gamePlay/nextSentence';
import { compileSentence } from '@/Stage/TextBox/TextBox';
import { useTextDelay, useTextAnimationDuration } from '@/hooks/useTextOptions';
import { getCharacterLoadingStatus, prepareStageCharacters } from '@/Core/util/sceneCharacterLoading';
import { webgalStore } from '@/store/store';

offlineExportHost?.register({
  core: WebGAL,
  store: webgalStore,
  stageManager: stageStateManager,
  parseScene: sceneParser,
  nativeAuto: switchAuto,
  nativeStopAuto: stopAuto,
  nativeNext: nextSentence,
  compileText: compileSentence,
  textDelay: useTextDelay,
  textAnimation: useTextAnimationDuration,
  getCharacterLoadingStatus,
  async prepareFigures() {
    const stage = WebGAL.gameplay.pixiStage;
    stage?.flushGltfTextures();
    await prepareStageCharacters(stageStateManager.getCalculationStageState(), new AbortController().signal);
  },
  renderFigures() { WebGAL.gameplay.pixiStage?.renderGltfPoses(); },
});
