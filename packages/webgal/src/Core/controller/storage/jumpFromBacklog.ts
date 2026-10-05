import { restoreStageScene } from './restoreStageScene';
import { logger } from '../../util/logger';
import { IStageState } from '@/Core/Modules/stage/stageInterface';
import { webgalStore } from '@/store/store';
import { setVisibility } from '@/store/GUIReducer';
import { runScript } from '@/Core/controller/gamePlay/runScript';
import { stopAllPerform } from '@/Core/controller/gamePlay/stopAllPerform';
import cloneDeep from 'lodash/cloneDeep';

import { WebGAL } from '@/Core/WebGAL';
import { stageStateManager } from '@/Core/Modules/stage/stageStateManager';

/**
 * 恢复演出
 */
export const restorePerform = (skipAnimation = false) => {
  const stageState = stageStateManager.getCalculationStageState();
  const performToRestore = cloneDeep(stageState.PerformList);
  // 清除状态表中演出序列
  stageStateManager.removeAllPerform();
  WebGAL.gameplay.performController.beginCollectingPerforms();
  try {
    performToRestore.forEach((e) => {
      runScript(e.script);
    });
  } finally {
    WebGAL.gameplay.performController.endCollectingPerforms();
  }
  stageStateManager.commit({ applyPixiEffects: false, skipAnimation });
  WebGAL.gameplay.performController.commitPendingPerforms();
  stageStateManager.applyCommittedPixiEffects();
};

/**
 * 从 backlog 跳转至一个先前的状态
 * @param index
 * @param refetchScene
 */
export const jumpFromBacklog = (index: number, refetchScene = true) => {
  const dispatch = webgalStore.dispatch;
  // 获得存档文件
  const backlogFile = cloneDeep(WebGAL.backlogManager.getBacklog()[index]);
  if (!backlogFile) return;
  logger.debug('读取的backlog数据', backlogFile);
  return restoreStageScene(backlogFile.saveScene, () => {
    // 强制停止所有演出
    stopAllPerform();

    // 弹出backlog项目到指定状态
    for (let i = WebGAL.backlogManager.getBacklog().length - 1; i > index; i--) {
      WebGAL.backlogManager.getBacklog().pop();
    }

    // 要记录本句 Backlog
    WebGAL.backlogManager.isSaveBacklogNext = true;

    // 恢复舞台状态
    const newStageState: IStageState = cloneDeep(backlogFile.currentStageState);

    // 确保原先未读的文本在使用 backlog 时能正确显示为已读文本
    newStageState.isRead = true;

    stageStateManager.replaceCalculationStageState(newStageState);

    // 恢复演出
    restorePerform();

    // 关闭backlog界面
    dispatch(setVisibility({ component: 'showBacklog', visibility: false }));

    // 重新显示 TextBox
    dispatch(setVisibility({ component: 'showTextBox', visibility: true }));

    // 重新渲染
    WebGAL.gameplay.pixiStage?.requestRender();
  }, refetchScene, backlogFile.currentStageState);
};
