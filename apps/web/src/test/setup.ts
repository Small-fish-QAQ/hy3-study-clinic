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

// jsdom implements FileReader but not the promise-based Blob read methods
// (blob.text() / blob.arrayBuffer()), which the file-import flows use to
// read picked files. Bridge the missing methods through FileReader.
function readBlobWith<T extends string | ArrayBuffer>(
  blob: Blob,
  start: (reader: FileReader) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as T);
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    start(reader);
  });
}
if (typeof globalThis.Blob.prototype.text !== 'function') {
  globalThis.Blob.prototype.text = function (this: Blob) {
    return readBlobWith<string>(this, (reader) => reader.readAsText(this));
  };
}
if (typeof globalThis.Blob.prototype.arrayBuffer !== 'function') {
  globalThis.Blob.prototype.arrayBuffer = function (this: Blob) {
    return readBlobWith<ArrayBuffer>(this, (reader) => reader.readAsArrayBuffer(this));
  };
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

/**
 * Keep getBoundingClientRect consistent with the element sizes above. jsdom
 * returns an all-zero rect, and React Flow's node-drag auto-pan measures the
 * flow pane with getBoundingClientRect at drag start: a 0×0 pane makes every
 * in-canvas pointer read as "past the pane edge", so each drag starts a
 * requestAnimationFrame pan loop that keeps moving the dragged node
 * (±autoPanSpeed ÷ zoom per frame, e.g. exactly +100,+100/frame at the
 * clamped 0.15 min-zoom) while the pointer is parked. Those asynchronous
 * position updates land outside act() and intermittently commit only at the
 * next act flush — breaking any test that compares node geometry across a
 * rerender. With a realistic pane box, pointers inside the canvas stay out
 * of the 40px auto-pan margin and dragged nodes move exactly as far as the
 * dispatched pointer events say. Only explicit PIXEL inline sizes shrink the
 * box: React Flow's own container carries inline `width/height: 100%`, which
 * must mean "fill the (mocked 800×600) canvas", not parseFloat('100%') = a
 * 100px pane that would re-trigger auto-pan. Drag coordinate math is
 * unchanged (left/top stay 0). SVG elements keep jsdom's default (getBBox
 * below).
 */
const inlinePixelSize = (value: string): number | null =>
  /^\d+(\.\d+)?px$/.test(value) ? parseFloat(value) : null;
globalThis.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  const width = inlinePixelSize(this.style.width) ?? 800;
  const height = inlinePixelSize(this.style.height) ?? 600;
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
};

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
