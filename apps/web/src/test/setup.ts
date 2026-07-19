import '@testing-library/jest-dom/vitest';

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
    // skipped entirely when the element has already been unmounted.
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
      this.callback(
        [{ target, contentRect } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
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
