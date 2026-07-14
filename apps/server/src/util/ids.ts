import { randomUUID } from 'node:crypto';

/** Prefix-tagged unique id, e.g. `mat_1a2b...`. Prefix aids debugging/logs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Injectable clock. Production uses the system clock; tests pass a fixed
 * clock so persisted `createdAt` values are deterministic.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that returns a fixed ISO instant — used in tests. */
export function fixedClock(iso: string): Clock {
  const date = new Date(iso);
  return { now: () => date };
}
