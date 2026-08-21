import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import {
  formatAppHash,
  parseAppRoute,
  type AppRoute,
  type CourseDestination,
} from './appRoutes.js';
import { AgentCourseWorkspace } from './views/AgentCourseWorkspace.js';
import {
  clearLastWorkspaceId,
  readLastWorkspaceId,
  rememberLastWorkspaceId,
} from './views/GraphWorkspaceView.js';

interface NavigationIntent {
  requestId: number;
  destination: CourseDestination;
}

function currentBrowserRoute(): AppRoute {
  return parseAppRoute(window.location.hash, window.location.search, readLastWorkspaceId()).route;
}

/** Canonical Course application shell with deterministic legacy-route compatibility. */
export function App() {
  const [route, setRoute] = useState<AppRoute>(currentBrowserRoute);
  const navigationSequence = useRef(0);
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent>(() => ({
    requestId: 0,
    destination: currentBrowserRoute().destination,
  }));
  const [provider, setProvider] = useState<'fake' | 'hy3' | null>(null);
  const providerRevisionRef = useRef(0);

  const applyProvider = useCallback((next: 'fake' | 'hy3' | null) => {
    providerRevisionRef.current += 1;
    setProvider(next);
  }, []);

  useEffect(() => {
    const revision = providerRevisionRef.current;
    const controller = new AbortController();
    void api
      .config(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted && providerRevisionRef.current === revision) {
          setProvider(config.provider);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && providerRevisionRef.current === revision) {
          setProvider(null);
        }
      });
    return () => controller.abort();
  }, []);

  const applyBrowserLocation = useCallback(() => {
    const parsed = parseAppRoute(
      window.location.hash,
      window.location.search,
      readLastWorkspaceId(),
    );
    if (window.location.hash !== parsed.canonicalHash || window.location.search) {
      window.history.replaceState(null, '', parsed.canonicalHash);
    }
    rememberLastWorkspaceId(parsed.route.workspaceId);
    setRoute(parsed.route);
    setNavigationIntent({
      requestId: ++navigationSequence.current,
      destination: parsed.route.destination,
    });
  }, []);

  useEffect(() => {
    applyBrowserLocation();
    window.addEventListener('hashchange', applyBrowserLocation);
    window.addEventListener('popstate', applyBrowserLocation);
    return () => {
      window.removeEventListener('hashchange', applyBrowserLocation);
      window.removeEventListener('popstate', applyBrowserLocation);
    };
  }, [applyBrowserLocation]);

  const navigate = useCallback((nextRoute: AppRoute) => {
    const canonicalHash = formatAppHash(nextRoute);
    if (window.location.hash !== canonicalHash || window.location.search) {
      window.history.pushState(null, '', canonicalHash);
    }
    rememberLastWorkspaceId(nextRoute.workspaceId);
    setRoute(nextRoute);
    setNavigationIntent({
      requestId: ++navigationSequence.current,
      destination: nextRoute.destination,
    });
  }, []);

  const handleDestinationChange = useCallback(
    (destination: CourseDestination) => {
      if (route.destination === destination) return;
      navigate({ workspaceId: route.workspaceId, destination });
    },
    [navigate, route.destination, route.workspaceId],
  );

  const handleWorkspaceChange = useCallback(
    (workspaceId: string | null) => {
      navigate({ workspaceId, destination: 'home' });
    },
    [navigate],
  );

  return (
    <AgentCourseWorkspace
      workspaceId={route.workspaceId}
      onWorkspaceChange={handleWorkspaceChange}
      refreshKey={0}
      provider={provider}
      onProviderChange={applyProvider}
      navigationIntent={navigationIntent}
      onDestinationChange={handleDestinationChange}
      onWorkspaceDeleted={(workspaceId) => {
        clearLastWorkspaceId(workspaceId);
        if (route.workspaceId === workspaceId) handleWorkspaceChange(null);
      }}
    />
  );
}
