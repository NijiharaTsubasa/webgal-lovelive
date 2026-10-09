import { useCallback, useLayoutEffect, useRef } from 'react';
import { attachLoopingBgm } from './BgmLoopController';

export function LoopingBgm({ src }: { src: string }) {
  const controller = useRef<ReturnType<typeof attachLoopingBgm>>();
  const ref = useCallback((element: HTMLAudioElement | null) => {
    controller.current?.dispose();
    controller.current = element ? attachLoopingBgm(element) : undefined;
  }, []);
  useLayoutEffect(() => {
    controller.current?.reset();
  }, [src]);
  // AudioContainer's effect owns autoplay, so native audio cannot race tagged playback.
  return <audio ref={ref} id="currentBgm" src={src} preload="none" loop />;
}
