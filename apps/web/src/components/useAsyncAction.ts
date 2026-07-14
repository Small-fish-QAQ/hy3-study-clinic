import { useCallback, useRef, useState } from 'react';
import { ApiClientError } from '../api.js';

export interface AsyncActionState {
  loading: boolean;
  error: string | null;
  cancel: () => void;
  clearError: () => void;
}

/**
 * Small helper around async actions with cancellation:
 * `run(fn)` invokes fn with a fresh AbortSignal; `cancel()` aborts it.
 * Cancellation is not surfaced as an error (the UI simply returns to idle).
 */
export function useAsyncAction(): AsyncActionState & {
  run: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async <T>(fn: (signal: AbortSignal) => Promise<T>) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await fn(controller.signal);
      return result;
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'ABORTED') {
        return null; // cancelled by the user — quiet return to idle
      }
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { run, cancel, loading, error, clearError };
}
