import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';
import type { AgentCourseWorkspaceProps } from './views/AgentCourseWorkspace.js';
import { App } from './App.js';

let mockWorkspaceProps: AgentCourseWorkspaceProps | null = null;
type ProviderConfig = Awaited<ReturnType<typeof api.config>>;

function providerConfig(provider: 'fake' | 'hy3'): ProviderConfig {
  return {
    provider,
    model: provider === 'hy3' ? 'test-model' : null,
    complete: true,
    source: 'default',
    baseUrl: null,
    apiKeyConfigured: provider === 'hy3',
    runtimeGeneration: 1,
    externalConnection: {
      status: 'untested',
      testedGeneration: null,
      testedAt: null,
      message: null,
    },
  };
}

vi.mock('./views/AgentCourseWorkspace.js', () => ({
  AgentCourseWorkspace: (props: AgentCourseWorkspaceProps) => {
    mockWorkspaceProps = props;
    return (
      <main aria-label="Course application mock">
        <span data-testid="workspace">{props.workspaceId ?? 'none'}</span>
        <span data-testid="destination">{props.navigationIntent?.destination ?? 'none'}</span>
        <span data-testid="provider">{props.provider ?? 'none'}</span>
        <button type="button" onClick={() => props.onDestinationChange?.('progress-repair')}>
          Open Repair
        </button>
        <button type="button" onClick={() => props.onWorkspaceChange('ws_2')}>
          Switch Course
        </button>
        <button type="button" onClick={() => props.onProviderChange?.('fake')}>
          Select fake provider
        </button>
      </main>
    );
  },
}));

describe('canonical Course application routing', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    mockWorkspaceProps = null;
    vi.spyOn(api, 'config').mockResolvedValue(providerConfig('fake'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes a legacy Quiz bookmark into the advanced Course assessment', async () => {
    window.localStorage.setItem('hy3-clinic:last-workspace-id', 'ws_1');
    window.history.replaceState(null, '', '/#/quiz');

    render(<App />);

    await waitFor(() =>
      expect(window.location.hash).toBe('#/course/ws_1/progress/manual-assessment'),
    );
    expect(screen.getByTestId('workspace')).toHaveTextContent('ws_1');
    expect(screen.getByTestId('destination')).toHaveTextContent('assessment');
  });

  it('keeps Course destination changes and Course switching in canonical history', async () => {
    window.history.replaceState(null, '', '/#/course/ws_1/home');
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Repair' }));
    await waitFor(() => expect(window.location.hash).toBe('#/course/ws_1/progress/repair'));

    fireEvent.click(screen.getByRole('button', { name: 'Switch Course' }));
    await waitFor(() => expect(window.location.hash).toBe('#/course/ws_2/home'));
    expect(screen.getByTestId('workspace')).toHaveTextContent('ws_2');
    expect(window.localStorage.getItem('hy3-clinic:last-workspace-id')).toBe('ws_2');
  });

  it('applies browser history as a fresh navigation intent without redirect loops', async () => {
    window.history.replaceState(null, '', '/#/course/ws_1/home');
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent('home'));
    const initialRequestId = mockWorkspaceProps?.navigationIntent?.requestId ?? -1;

    act(() => {
      window.history.pushState(null, '', '#/course/ws_1/progress/history');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('destination')).toHaveTextContent('progress-history'),
    );
    expect(mockWorkspaceProps?.navigationIntent?.requestId).toBeGreaterThan(initialRequestId);
    expect(window.location.hash).toBe('#/course/ws_1/progress/history');
  });

  it('does not let stale provider bootstrap overwrite a newer Settings choice', async () => {
    let resolveConfig!: (value: ProviderConfig) => void;
    vi.mocked(api.config).mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Select fake provider' }));
    expect(screen.getByTestId('provider')).toHaveTextContent('fake');
    await act(async () => resolveConfig(providerConfig('hy3')));
    expect(screen.getByTestId('provider')).toHaveTextContent('fake');
  });
});
