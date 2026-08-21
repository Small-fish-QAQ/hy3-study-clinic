export type CourseDestination =
  | 'home'
  | 'study'
  | 'curriculum'
  | 'knowledge-map'
  | 'progress-overview'
  | 'progress-evidence'
  | 'progress-repair'
  | 'progress-mastery'
  | 'progress-history'
  | 'materials'
  | 'settings'
  | 'grounding'
  | 'assessment';

export interface AppRoute {
  workspaceId: string | null;
  destination: CourseDestination;
}

export interface ParsedAppRoute {
  route: AppRoute;
  canonicalHash: string;
  legacy: boolean;
}

const DESTINATION_PATH: Record<CourseDestination, string> = {
  home: 'home',
  study: 'study',
  curriculum: 'curriculum',
  'knowledge-map': 'knowledge-map',
  'progress-overview': 'progress',
  'progress-evidence': 'progress/evidence',
  'progress-repair': 'progress/repair',
  'progress-mastery': 'progress/mastery',
  'progress-history': 'progress/history',
  materials: 'materials',
  settings: 'settings',
  grounding: 'curriculum/grounding',
  assessment: 'progress/manual-assessment',
};

const LEGACY_DESTINATIONS: Record<string, CourseDestination> = {
  graph: 'knowledge-map',
  explore: 'knowledge-map',
  quiz: 'assessment',
  assessment: 'assessment',
  results: 'progress-history',
  history: 'progress-history',
  mistakes: 'progress-repair',
  mistake: 'progress-repair',
  remediation: 'progress-repair',
  repair: 'progress-repair',
  mastery: 'progress-mastery',
  review: 'progress-mastery',
  import: 'materials',
  materials: 'materials',
  hy3: 'settings',
  provider: 'settings',
  settings: 'settings',
  compatibility: 'grounding',
  advanced: 'grounding',
};

export function formatAppHash(route: AppRoute): string {
  if (!route.workspaceId) {
    return route.destination === 'settings' ? '#/settings' : '#/courses';
  }
  return `#/course/${encodeURIComponent(route.workspaceId)}/${DESTINATION_PATH[route.destination]}`;
}

export function parseAppRoute(
  hash: string,
  search: string,
  fallbackWorkspaceId: string | null,
): ParsedAppRoute {
  const path = normalizedPath(hash);
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const queryWorkspace = query.get('workspaceId') ?? query.get('workspace');
  const workspaceId = queryWorkspace || fallbackWorkspaceId;

  if (path === '' || path === '/') {
    const legacyValue = query.get('view') ?? query.get('tab') ?? query.get('module');
    if (legacyValue) return legacyRoute(legacyValue, workspaceId);
    return parsed({ workspaceId, destination: 'home' }, false);
  }

  if (path === '/courses') return parsed({ workspaceId: null, destination: 'home' }, false);
  if (path === '/settings') {
    return parsed({ workspaceId, destination: 'settings' }, false);
  }

  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  if (segments[0] === 'course' && segments[1]) {
    const courseWorkspaceId = segments[1];
    const destination = destinationFromCoursePath(segments.slice(2));
    if (destination) {
      return parsed({ workspaceId: courseWorkspaceId, destination }, false);
    }
    return parsed({ workspaceId: courseWorkspaceId, destination: 'home' }, true);
  }

  return legacyRoute(segments.at(-1) ?? '', workspaceId);
}

function parsed(route: AppRoute, legacy: boolean): ParsedAppRoute {
  const normalizedRoute =
    route.workspaceId || route.destination === 'settings'
      ? route
      : { workspaceId: null, destination: 'home' as const };
  return { route: normalizedRoute, canonicalHash: formatAppHash(normalizedRoute), legacy };
}

function legacyRoute(value: string, workspaceId: string | null): ParsedAppRoute {
  const destination = LEGACY_DESTINATIONS[value.trim().toLowerCase()] ?? 'home';
  return parsed({ workspaceId, destination }, true);
}

function destinationFromCoursePath(segments: string[]): CourseDestination | null {
  const path = segments.join('/').toLowerCase();
  const byPath = new Map<string, CourseDestination>(
    Object.entries(DESTINATION_PATH).map(([destination, value]) => [
      value,
      destination as CourseDestination,
    ]),
  );
  return byPath.get(path || 'home') ?? null;
}

function normalizedPath(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  if (!withoutQuery) return '';
  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
