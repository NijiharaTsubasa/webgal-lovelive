import { cancelPendingForward } from './nextSentence';
import { WebGAL } from '@/Core/WebGAL';
import { webgalStore } from '@/store/store';
import { setVisibility } from '@/store/GUIReducer';
import { stopAllPerform } from '@/Core/controller/gamePlay/stopAllPerform';
import { stopAuto } from '@/Core/controller/gamePlay/autoPlay';
import { stopFast } from '@/Core/controller/gamePlay/fastSkip';
import { setEbg } from '@/Core/gameScripts/changeBg/setEbg';
import { stageStateManager } from '@/Core/Modules/stage/stageStateManager';
import { fastSaveGame } from '../storage/fastSaveLoad';

export const backToTitle = () => {
  if (webgalStore.getState().GUI.showTitle) return;
  cancelPendingForward();
  WebGAL.sceneManager.sceneWritePromise = null;
  WebGAL.sceneManager.lockSceneWrite = false;
  fastSaveGame();
  const dispatch = webgalStore.dispatch;
  stopAllPerform();
  stopAuto();
  stopFast();
  // 清除语音
  stageStateManager.setStageAndCommit('playVocal', '');
  // 重新打开标题界面
  dispatch(setVisibility({ component: 'showTitle', visibility: true }));
  /**
   * 重设为标题背景
   */
  setEbg(webgalStore.getState().GUI.titleBg);
};
