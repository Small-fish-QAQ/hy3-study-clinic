import '@testing-library/jest-dom/vitest';
import { act } from '@testing-library/react';

/**
 * jsdom shims required by @xyflow/react (React Flow) — per the library's
 * official testing guidance. jsdom implements neither ResizeObserver nor
 * DOMMatrixReadOnly; React Flow needs both to measure and place nodes.
 */
class ResizeObserverMock {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    // Deferred so React finishes committing before React Flow measures;
    // skipped entirely when the element has already been unmounted. The
    // callback triggers React Flow store updates (node measurement), so it
    // must run inside act() — this is the environment "firing an event",
    // exactly what act() is for, not a warning suppression.
    queueMicrotask(() => {
      if (!target.isConnected) return;
      const contentRect = {
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        toJSON: () => ({}),
      };
      act(() => {
        this.callback(
          [{ target, contentRect } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      });
    });
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyMock {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? +scale : 1;
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}
if (typeof (globalThis as Record<string, unknown>).DOMMatrixReadOnly === 'undefined') {
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyMock;
}

// jsdom lacks matchMedia; report reduced motion so viewport animations run
// synchronously in tests (the app honors prefers-reduced-motion anyway).
if (typeof window.matchMedia === 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// React Flow reads element sizes; give jsdom elements a non-zero box.
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: {
    configurable: true,
    get() {
      return parseFloat((this as HTMLElement).style.height) || 600;
    },
  },
  offsetWidth: {
    configurable: true,
    get() {
      return parseFloat((this as HTMLElement).style.width) || 800;
    },
  },
});

(globalThis.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

// d3-zoom (used by React Flow's pan/zoom pane) reads `event.view.document`;
// events dispatched by testing-library carry `view: null` in jsdom. Report
// the jsdom window as every UI event's view so canvas interactions are safe.
Object.defineProperty(window.UIEvent.prototype, 'view', {
  configurable: true,
  get() {
    return window;
  },
});
