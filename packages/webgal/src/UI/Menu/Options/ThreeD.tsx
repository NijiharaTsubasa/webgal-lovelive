import styles from './options.module.scss';
import loadingOptionStyles from './System/characterLoadingOption.module.scss';
import { NormalOption } from './NormalOption';
import { NormalButton } from './NormalButton';
import { setOptionData } from '@/store/userDataReducer';
import { setStorage } from '@/Core/controller/storage/storageController';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, webgalStore } from '@/store/store';
import { releaseSceneCharacters } from '@/Core/util/sceneCharacterLoading';
import useTrans from '@/hooks/useTrans';

export function ThreeD() {
  const userDataState = useSelector((state: RootState) => state.userData);
  const dispatch = useDispatch();
  const showTitle = useSelector((state: RootState) => state.GUI.showTitle);
  const setCloth = (value: boolean) => {
    if (!webgalStore.getState().GUI.showTitle) return;
    releaseSceneCharacters();
    dispatch(setOptionData({ key: 'meshClothEnabled', value }));
    setStorage();
  };
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
      <div className={loadingOptionStyles.option}>
        <h3 className={loadingOptionStyles.sectionTitle}>{t('meshCloth.experimental')}</h3>
        <NormalOption title={t('meshCloth.title')}>
          <div
            aria-disabled={!showTitle}
            className={`${loadingOptionStyles.clothButtons} ${!showTitle ? loadingOptionStyles.disabled : ''}`}
          >
            <NormalButton
              textList={t('meshCloth.off', 'meshCloth.on')}
              functionList={[() => setCloth(false), () => setCloth(true)]}
              currentChecked={userDataState.optionData.meshClothEnabled ? 1 : 0}
            />
          </div>
        </NormalOption>
        <p className={loadingOptionStyles.description}>{t('meshCloth.description')}</p>
        {!showTitle && <p className={loadingOptionStyles.description}>{t('meshCloth.titleOnly')}</p>}
      </div>
    </div>
  );
}
