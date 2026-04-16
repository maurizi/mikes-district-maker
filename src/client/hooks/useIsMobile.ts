import { useSyncExternalStore } from "react";

function createMediaQueryHook(query: string) {
  function subscribe(callback: () => void): () => void {
    const mql = window.matchMedia(query);
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  }

  function getSnapshot(): boolean {
    return window.matchMedia(query).matches;
  }

  function getServerSnapshot(): boolean {
    return false;
  }

  return function useMediaQuery(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  };
}

const useIsMobile = createMediaQueryHook("(max-width: 40em)");
export const useIsNarrowViewport = createMediaQueryHook("(max-width: 55em)");
export default useIsMobile;
