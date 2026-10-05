import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import {
  getCharacterLoadingStatus,
  retryCharacterLoading,
  setCharacterLoadingMode,
  subscribeCharacterLoading,
} from '@/Core/util/sceneCharacterLoading';
import useTrans from '@/hooks/useTrans';
import { logger } from '@/Core/util/logger';
import useApplyStyle from '@/hooks/useApplyStyle';
import styles from './characterLoading.module.scss';

export default function CharacterLoading() {
  const [status, setStatus] = useState(getCharacterLoadingStatus);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const mode = useSelector((state: RootState) => state.userData.optionData.characterLoadingMode);
  const t = useTrans('characterLoading.');
  const applyStyle = useApplyStyle('characterLoading');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const updateStatus = (next: ReturnType<typeof getCharacterLoadingStatus>) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (next.phase === 'loading' && (next.kind === 'stage' || next.kind === 'scene')) {
        // The preparation gate still blocks advancement during a short cache hit.
        setStatus({ phase: 'idle' });
        timer = setTimeout(() => {
          timer = undefined;
          setStatus(next);
        }, 150);
      } else setStatus(next);
    };
    const unsubscribe = subscribeCharacterLoading(updateStatus);
    updateStatus(getCharacterLoadingStatus());
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const indicator = indicatorRef.current;
    if (!indicator) return;
    const textbox = document.getElementById('textBoxMain');
    if (!textbox) return;
    const position = () => {
      const parent = indicator.parentElement!;
      const bounds = parent.getBoundingClientRect();
      const box = textbox.getBoundingClientRect();
      if (!bounds.width || !bounds.height || !box.width || !box.height) return;
      indicator.style.setProperty(
        '--character-loading-anchor-x',
        `${((box.right - bounds.left) / bounds.width) * parent.clientWidth}px`,
      );
      indicator.style.setProperty(
        '--character-loading-anchor-y',
        `${((box.bottom - bounds.top) / bounds.height) * parent.clientHeight}px`,
      );
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(textbox);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
    };
  });
  useEffect(() => {
    setCharacterLoadingMode(mode === 'on-demand' ? 'on-demand' : 'scene');
  }, [mode]);

  useEffect(() => {
    const blockSceneInput = (event: Event) => {
      const current = getCharacterLoadingStatus();
      if (current.phase === 'idle' || current.kind !== 'scene') return;
      if (event.target instanceof Element && event.target.closest('[data-scene-loading]')) {
        const keyboardEvent = event as KeyboardEvent;
        if (!event.type.startsWith('key') || ['Enter', ' ', 'Tab'].includes(keyboardEvent.key)) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['click', 'pointerdown', 'contextmenu', 'wheel', 'keydown', 'keyup'];
    for (const type of events) document.addEventListener(type, blockSceneInput, { capture: true, passive: false });
    return () => {
      for (const type of events) document.removeEventListener(type, blockSceneInput, true);
    };
  }, []);

  if (status.phase === 'idle') return null;

  return (
    <div
      className={`${styles.overlay} ${status.kind === 'scene' ? styles.scene : styles.stage}`}
      data-scene-loading={status.kind === 'scene' ? '' : undefined}
    >
      <div
        ref={indicatorRef}
        className={`${applyStyle(
          status.kind === 'scene' ? 'CharacterLoading_sceneIndicator' : 'CharacterLoading_stageIndicator',
          styles.indicator,
        )}${status.phase === 'error' ? ` ${styles.errorIndicator}` : ''}`}
        role="status"
        aria-live="polite"
        aria-label={t('preparing')}
      >
        {status.phase === 'loading' ? (
          <div
            className={applyStyle(
              status.kind === 'scene' ? 'CharacterLoading_sceneImage' : 'CharacterLoading_stageImage',
              styles.image,
            )}
            role="img"
            aria-label="NOW LOADING"
          />
        ) : (
          <div className={applyStyle('CharacterLoading_error', styles.error)}>{t('failed')}</div>
        )}
        <div className={styles.buttons}>
          {status.phase === 'error' && (
            <button
              type="button"
              className={applyStyle('CharacterLoading_retry', styles.retry)}
              onKeyDown={(event) => event.stopPropagation()}
              onKeyUp={(event) => event.stopPropagation()}
              onClick={() => {
                void retryCharacterLoading().catch((error) => logger.error('角色加载重试失败', error));
              }}
            >
              {t('retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
