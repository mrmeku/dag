/**
 * Pins the global bans of dagraph's components (dag/eslint.dagraph.ts). Each banned use below is
 * refused, so the directive above it is used, and lint fails on a directive left unused. A type
 * that names `Date` is no use, and passes.
 */
export const lastUse: Date | undefined = undefined;

// eslint-disable-next-line no-restricted-syntax -- a read of Date
export const now = () => Date.now();
// eslint-disable-next-line no-restricted-syntax -- a read of Date
export const epoch = () => new Date(0);
// eslint-disable-next-line no-restricted-syntax -- a read of Date, as a value
export const clock = { now: Date };
// eslint-disable-next-line no-restricted-syntax -- a read of setTimeout
export const startTimeout = (onTimeout: () => void) => setTimeout(onTimeout, 1);
// eslint-disable-next-line no-restricted-syntax -- a read of clearTimeout
export const stopTimeout = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
// eslint-disable-next-line no-restricted-syntax -- a read of crypto
export const stagingName = () => crypto.randomUUID();
// eslint-disable-next-line no-restricted-syntax -- Math.random
export const jitter = () => Math.random();
// eslint-disable-next-line no-restricted-syntax -- a read of globalThis
export const later = () => globalThis.setTimeout(() => {}, 1);
