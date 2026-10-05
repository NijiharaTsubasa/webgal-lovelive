import styles from './options.module.scss';
import loadingOptionStyles from './System/characterLoadingOption.module.scss';
import { NormalOption } from './NormalOption';
import { NormalButton } from './NormalButton';
import { setOptionData } from '@/store/userDataReducer';
import { setStorage } from '@/Core/controller/storage/storageController';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import useTrans from '@/hooks/useTrans';

export function ThreeD() {
  const userDataState = useSelector((state: RootState) => state.userData);
  const dispatch = useDispatch();
  const t = useTrans('menu.options.pages.system.options.');
  return (
    <div className={styles.Options_main_content_half}>
      <div className={loadingOptionStyles.option}>
        <NormalOption key="characterLoading" title={t('characterLoading.title')}>
          <NormalButton
            textList={t('characterLoading.options.scene', 'characterLoading.options.onDemand')}
            functionList={[
              () => {
                dispatch(setOptionData({ key: 'characterLoadingMode', value: 'scene' }));
                setStorage();
              },
              () => {
                dispatch(setOptionData({ key: 'characterLoadingMode', value: 'on-demand' }));
                setStorage();
              },
            ]}
            currentChecked={userDataState.optionData.characterLoadingMode === 'on-demand' ? 1 : 0}
          />
        </NormalOption>
        <p className={loadingOptionStyles.description}>
          {t(
            userDataState.optionData.characterLoadingMode === 'on-demand'
              ? 'characterLoading.description.onDemand'
              : 'characterLoading.description.scene',
          )}
        </p>
      </div>
    </div>
  );
}
