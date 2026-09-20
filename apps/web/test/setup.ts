/**
 * A window, just enough of one.
 *
 * `happy-dom` would work and costs a slow install plus a whole DOM these tests
 * do not touch. What `offline.ts` actually needs from a browser is two event
 * listener methods and `crypto.randomUUID`, so that is what it gets — and
 * keeping it this small means the test environment cannot quietly provide
 * something the real browser would not.
 */
// Loaded here rather than in each spec: vitest hoists `vi.mock` but not plain
// side-effecting imports, so a spec importing the module under test on line 1
// could evaluate it before fake-indexeddb had installed the global.
import 'fake-indexeddb/auto';

if (!('window' in globalThis)) {
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    value: {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    },
    configurable: true,
  });
}
