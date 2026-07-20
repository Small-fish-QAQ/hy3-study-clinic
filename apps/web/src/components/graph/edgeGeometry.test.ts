import { describe, expect, it } from 'vitest';
import {
  boundaryPoint,
  clamp,
  cubicPoint,
  distance,
  NODE_CORNER_RADIUS,
  pointInRect,
  quadraticPoint,
  rectCenter,
  sanitizeRect,
  segmentIntersectsRect,
  segmentsIntersect,
  shiftAlongSide,
  slotOffset,
  type Rect,
} from './edgeGeometry';
import { estimateNodeSize } from './layout';

/** Floating-endpoint geometry regressions (defect: fixed top/bottom handles). */

const rect: Rect = { x: 100, y: 100, width: 160, height: 60 };
const center = rectCenter(rect); // (180, 130)

function expectOnBoundary(point: { x: number; y: number }, r: Rect) {
  const onVertical =
    (point.x === r.x || point.x === r.x + r.width) && point.y >= r.y && point.y <= r.y + r.height;
  const onHorizontal =
    (point.y === r.y || point.y === r.y + r.height) && point.x >= r.x && point.x <= r.x + r.width;
  expect(onVertical || onHorizontal).toBe(true);
}

describe('boundaryPoint — cardinal directions', () => {
  it('target to the right exits the right side', () => {
    const { point, side } = boundaryPoint(rect, { x: 600, y: 130 });
    expect(side).toBe('right');
    expect(point).toEqual({ x: 260, y: 130 });
  });

  it('target to the left exits the left side', () => {
    const { point, side } = boundaryPoint(rect, { x: -300, y: 130 });
    expect(side).toBe('left');
    expect(point).toEqual({ x: 100, y: 130 });
  });

  it('target above exits the top side', () => {
    const { point, side } = boundaryPoint(rect, { x: 180, y: -200 });
    expect(side).toBe('top');
    expect(point).toEqual({ x: 180, y: 100 });
  });

  it('target below exits the bottom side', () => {
    const { point, side } = boundaryPoint(rect, { x: 180, y: 500 });
    expect(side).toBe('bottom');
    expect(point).toEqual({ x: 180, y: 160 });
  });
});

describe('boundaryPoint — diagonal quadrants', () => {
  const targets = [
    { name: 'upper-right', toward: { x: 500, y: -100 } },
    { name: 'upper-left', toward: { x: -200, y: -150 } },
    { name: 'lower-right', toward: { x: 520, y: 400 } },
    { name: 'lower-left', toward: { x: -180, y: 380 } },
  ];
  for (const { name, toward } of targets) {
    it(`${name} endpoint lies on the boundary, outside the interior`, () => {
      const { point } = boundaryPoint(rect, toward);
      expectOnBoundary(point, rect);
      // Strictly not inside the interior.
      expect(
        point.x > rect.x &&
          point.x < rect.x + rect.width &&
          point.y > rect.y &&
          point.y < rect.y + rect.height,
      ).toBe(false);
    });
  }

  it('shallow diagonal exits a vertical side, steep diagonal a horizontal side', () => {
    expect(boundaryPoint(rect, { x: 800, y: 160 }).side).toBe('right');
    expect(boundaryPoint(rect, { x: 190, y: 800 }).side).toBe('bottom');
  });
});

describe('boundaryPoint — node size variety', () => {
  it('supports differently sized nodes', () => {
    const small: Rect = { x: 0, y: 0, width: 40, height: 24 };
    const large: Rect = { x: 0, y: 0, width: 400, height: 200 };
    expect(boundaryPoint(small, { x: 999, y: 12 }).point.x).toBe(40);
    expect(boundaryPoint(large, { x: 999, y: 100 }).point.x).toBe(400);
  });

  it('supports estimated sizes for long labels and degree-scaled nodes', () => {
    const long = estimateNodeSize('工作记忆与长时记忆的巩固机制比较研究', 0);
    const scaled = estimateNodeSize('工作记忆', 6);
    for (const size of [long, scaled]) {
      const r: Rect = { x: 10, y: 10, ...size };
      const { point } = boundaryPoint(r, { x: 1000, y: 500 });
      expectOnBoundary(point, r);
    }
    // Degree scaling grows the node, never shrinks it.
    expect(scaled.width).toBeGreaterThan(estimateNodeSize('工作记忆', 0).width);
  });
});

describe('boundaryPoint — rounded corners and degenerate input', () => {
  it('clamps a near-corner intersection onto the straight section', () => {
    // Aim almost exactly at the top-right corner.
    const { point, side } = boundaryPoint(rect, { x: 260 + 80, y: 100 - 31 });
    if (side === 'top' || side === 'bottom') {
      expect(point.x).toBeLessThanOrEqual(rect.x + rect.width - NODE_CORNER_RADIUS);
      expect(point.x).toBeGreaterThanOrEqual(rect.x + NODE_CORNER_RADIUS);
    } else {
      expect(point.y).toBeLessThanOrEqual(rect.y + rect.height - NODE_CORNER_RADIUS);
      expect(point.y).toBeGreaterThanOrEqual(rect.y + NODE_CORNER_RADIUS);
    }
  });

  it('degenerate target (the center itself) deterministically exits right', () => {
    const { point, side } = boundaryPoint(rect, center);
    expect(side).toBe('right');
    expect(point).toEqual({ x: 260, y: 130 });
  });

  it('never produces NaN, even for hostile input', () => {
    const cases = [
      boundaryPoint(rect, { x: Number.NaN, y: Number.NaN }),
      boundaryPoint(rect, { x: Number.POSITIVE_INFINITY, y: 130 }),
      boundaryPoint({ x: 0, y: 0, width: 0, height: 0 }, { x: 10, y: 10 }),
    ];
    for (const { point } of cases) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});

describe('sanitizeRect — unmeasured-node fallback', () => {
  it('replaces non-finite values and zero sizes with the fallback', () => {
    const fallback: Rect = { x: 0, y: 0, width: 160, height: 56 };
    const fixed = sanitizeRect(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 0, height: -5 },
      fallback,
    );
    expect(fixed.x).toBe(0);
    expect(fixed.y).toBe(0);
    expect(fixed.width).toBeGreaterThanOrEqual(1);
    expect(fixed.height).toBeGreaterThanOrEqual(1);
  });
});

describe('side slots', () => {
  it('single edge gets no offset; multiple edges spread symmetrically', () => {
    expect(slotOffset(0, 1, 160)).toBe(0);
    const spread = [0, 1, 2].map((rank) => slotOffset(rank, 3, 160));
    expect(spread[1]).toBe(0);
    expect(spread[0]).toBeLessThan(0);
    expect(spread[2]).toBeGreaterThan(0);
    expect(spread[2]).toBe(-spread[0]!);
  });

  it('offsets stay bounded for very high degree', () => {
    for (let rank = 0; rank < 12; rank++) {
      expect(Math.abs(slotOffset(rank, 12, 160))).toBeLessThanOrEqual(16 * 6);
    }
  });

  it('shiftAlongSide keeps the point on the straight section of the side', () => {
    const boundary = boundaryPoint(rect, { x: 600, y: 130 });
    const shifted = shiftAlongSide(boundary, 999, rect);
    expect(shifted.x).toBe(260);
    expect(shifted.y).toBe(rect.y + rect.height - NODE_CORNER_RADIUS);
    const shiftedUp = shiftAlongSide(boundary, -999, rect);
    expect(shiftedUp.y).toBe(rect.y + NODE_CORNER_RADIUS);
  });
});

describe('segment/curve primitives', () => {
  it('detects segment intersections and containment', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 })).toBe(
      false,
    );
    expect(segmentIntersectsRect({ x: 0, y: 130 }, { x: 500, y: 130 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 500, y: 0 }, rect)).toBe(false);
    // The margin inflates the obstacle.
    expect(segmentIntersectsRect({ x: 0, y: 95 }, { x: 500, y: 95 }, rect, 10)).toBe(true);
  });

  it('evaluates Bézier points and helpers deterministically', () => {
    const p = quadraticPoint({ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 }, 0.5);
    expect(p).toEqual({ x: 50, y: 50 });
    const c = cubicPoint(
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      0.5,
    );
    expect(c.x).toBeCloseTo(50);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(pointInRect({ x: 180, y: 130 }, rect)).toBe(true);
    expect(pointInRect({ x: 99, y: 130 }, rect)).toBe(false);
    expect(pointInRect({ x: 95, y: 130 }, rect, 6)).toBe(true);
  });
});
