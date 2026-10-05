import { assetSetter, fileType } from '../../util/gameAssetsAccess/assetSetter';
import { changeScene } from '../scene/changeScene';
import { resetStage } from '@/Core/controller/stage/resetStage';
import { webgalStore } from '@/store/store';
import { setVisibility } from '@/store/GUIReducer';
import { continueSentence } from '@/Core/controller/gamePlay/nextSentence';
import { setEbg } from '@/Core/gameScripts/changeBg/setEbg';
import { restorePerform } from '@/Core/controller/storage/jumpFromBacklog';

import { hasFastSaveRecord, loadFastSaveGame } from '@/Core/controller/storage/fastSaveLoad';
import { WebGAL } from '@/Core/WebGAL';
import { stageStateManager } from '@/Core/Modules/stage/stageStateManager';

/**
 * 从头开始游戏
 */
export const startGame = () => {
  resetStage(true);

  // 重新获取初始场景
  const sceneUrl: string = assetSetter('start.txt', fileType.scene);
  const pending = changeScene(sceneUrl, 'start.txt');
  webgalStore.dispatch(setVisibility({ component: 'showTitle', visibility: false }));
  return pending;
};

export async function continueGame() {
  /**
   * 重设模糊背景
   */
  setEbg(stageStateManager.getViewStageState().bgName);
  if (await hasFastSaveRecord()) {
    webgalStore.dispatch(setVisibility({ component: 'showTitle', visibility: false }));
    // 恢复记录
    await loadFastSaveGame();
  }
}
