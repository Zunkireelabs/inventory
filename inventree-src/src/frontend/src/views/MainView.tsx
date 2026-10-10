import '@mantine/core/styles.css';
import { type ComponentType, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { setApiDefaults } from '../App';
import { useLocalState } from '../states/LocalState';

// Uses window.innerWidth/innerHeight directly (snapshotted, not subscribed
// to every resize) rather than useViewportSize(): on mobile browsers,
// opening the on-screen keyboard shrinks the visual viewport height below
// the 425px threshold while it animates in, which previously flipped this
// check back and forth and remounted the entire Mobile/Desktop view tree
// (each view mounts its own BrowserRouter) — visible as repeated blinking.
// Re-checking only on 'orientationchange' still catches real device
// rotation without reacting to keyboard-driven height changes.
function checkMobile() {
  const { innerWidth: width, innerHeight: height } = window;
  return width < 425 || height < 425;
}

// Import both views eagerly (outside React.lazy/Suspense): a lazy component
// always suspends on its first render, and React's Suspense commit-delay
// heuristic can then hold that first commit - and every effect beneath it,
// including locale and layout loading - back by several hundred ms, even
// though the underlying chunk is already cached by the time it's needed.
const desktopViewPromise = import('./DesktopAppView').then((m) => m.default);
const mobileViewPromise = import('./MobileAppView').then((m) => m.default);

// Main App
export default function MainView() {
  const [allowMobile] = useLocalState(
    useShallow((state) => [state.allowMobile])
  );
  const [DesktopView, setDesktopView] = useState<ComponentType | null>(null);
  const [MobileView, setMobileView] = useState<ComponentType | null>(null);

  // Set initial login status
  useEffect(() => {
    try {
      // Local state initialization
      setApiDefaults();
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    desktopViewPromise.then((Component) => setDesktopView(() => Component));
    mobileViewPromise.then((Component) => setMobileView(() => Component));
  }, []);

  // Snapshot the mobile/desktop decision once on mount, and only
  // re-check it on an actual device rotation. Re-deriving this on every
  // resize (e.g. via a hook subscribed to window resize events) flips it
  // spuriously whenever an on-screen keyboard opens/closes, which remounts
  // the entire view tree below.
  const [isSmallViewport, setIsSmallViewport] = useState(checkMobile);

  useEffect(() => {
    const handleOrientationChange = () => setIsSmallViewport(checkMobile());
    window.addEventListener('orientationchange', handleOrientationChange);
    return () =>
      window.removeEventListener('orientationchange', handleOrientationChange);
  }, []);

  // Check if mobile
  const isMobile =
    !allowMobile &&
    window.INVENTREE_SETTINGS.mobile_mode !== 'allow-always' &&
    isSmallViewport;

  const View = isMobile ? MobileView : DesktopView;

  if (!View) {
    return null;
  }

  return <View />;
}
