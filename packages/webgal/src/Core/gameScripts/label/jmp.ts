import { cancelPendingForward, continueSentence } from '@/Core/controller/gamePlay/nextSentence';
import { jumpToLabel } from '@/Core/gameScripts/label/jumpToLabel';
import { getCharacterLoadingStatus } from '@/Core/util/sceneCharacterLoading';

export const jmp = (labelName: string, autoNext = true) => {
  const isJumped = jumpToLabel(labelName);
  const loading = getCharacterLoadingStatus();
  if (isJumped && loading.kind === 'stage' && loading.phase !== 'idle') cancelPendingForward();
  if (isJumped && autoNext) {
    continueSentence();
  }
};
