import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../api.js';

export interface AsyncActionState {
  loading: boolean;
  error: string | null;
  errorDetails: unknown | null;
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
  const [errorDetails, setErrorDetails] = useState<unknown | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const run = useCallback(async <T>(fn: (signal: AbortSignal) => Promise<T>) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setErrorDetails(null);
    try {
      const result = await fn(controller.signal);
      if (controller.signal.aborted || controllerRef.current !== controller) return null;
      return result;
    } catch (err) {
      if (controller.signal.aborted || (err instanceof ApiClientError && err.code === 'ABORTED')) {
        return null; // cancelled by the user — quiet return to idle
      }
      if (mountedRef.current && controllerRef.current === controller) {
        setError(err instanceof Error ? err.message : String(err));
        setErrorDetails(err instanceof ApiClientError ? (err.details ?? null) : null);
      }
      return null;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (mountedRef.current) setLoading(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorDetails(null);
  }, []);

  return { run, cancel, loading, error, errorDetails, clearError };
}
