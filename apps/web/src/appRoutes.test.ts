import { describe, expect, it } from 'vitest';
import { formatAppHash, parseAppRoute, type CourseDestination } from './appRoutes.js';

describe('Course route compatibility', () => {
  it.each([
    ['#/graph', 'knowledge-map'],
    ['#/explore', 'knowledge-map'],
    ['#/quiz', 'assessment'],
    ['#/history', 'progress-history'],
    ['#/mistakes', 'progress-repair'],
    ['#/repair', 'progress-repair'],
    ['#/mastery', 'progress-mastery'],
    ['#/review', 'progress-mastery'],
    ['#/materials', 'materials'],
    ['#/provider', 'settings'],
    ['#/compatibility', 'grounding'],
  ] as Array<[string, CourseDestination]>)('%s redirects to %s', (hash, destination) => {
    const parsed = parseAppRoute(hash, '', 'ws_saved');
    expect(parsed.route).toEqual({ workspaceId: 'ws_saved', destination });
    expect(parsed.legacy).toBe(true);
    expect(parseAppRoute(parsed.canonicalHash, '', null)).toMatchObject({
      route: parsed.route,
      legacy: false,
    });
  });

  it('preserves an explicit canonical Course identity instead of browser fallback state', () => {
    const parsed = parseAppRoute('#/course/ws_bookmark/progress/repair', '', 'ws_saved');
    expect(parsed).toMatchObject({
      route: { workspaceId: 'ws_bookmark', destination: 'progress-repair' },
      legacy: false,
    });
  });

  it('accepts the historical query navigation shape and normalizes it once', () => {
    const parsed = parseAppRoute('', '?view=quiz&workspaceId=ws_query', 'ws_saved');
    expect(parsed.route).toEqual({ workspaceId: 'ws_query', destination: 'assessment' });
    expect(parsed.legacy).toBe(true);
    expect(parseAppRoute(parsed.canonicalHash, '', null).legacy).toBe(false);
  });

  it('does not preserve a Course-only destination when no Course can own it', () => {
    expect(parseAppRoute('#/quiz', '', null)).toMatchObject({
      route: { workspaceId: null, destination: 'home' },
      canonicalHash: '#/courses',
      legacy: true,
    });
    expect(parseAppRoute('#/settings', '', null).route.destination).toBe('settings');
  });

  it('round-trips every canonical destination without redirect loops', () => {
    const destinations: CourseDestination[] = [
      'home',
      'study',
      'curriculum',
      'knowledge-map',
      'progress-overview',
      'progress-evidence',
      'progress-repair',
      'progress-mastery',
      'progress-history',
      'materials',
      'settings',
      'grounding',
      'assessment',
    ];
    for (const destination of destinations) {
      const route = { workspaceId: 'ws_1', destination } as const;
      const parsed = parseAppRoute(formatAppHash(route), '', null);
      expect(parsed.route).toEqual(route);
      expect(parsed.legacy).toBe(false);
      expect(parsed.canonicalHash).toBe(formatAppHash(route));
    }
  });
});
