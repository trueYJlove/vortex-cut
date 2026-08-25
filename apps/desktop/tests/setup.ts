import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

// jsdom does not implement real media playback. Several tests call
// vi.restoreAllMocks() in afterEach, which would bring back jsdom's native
// play() (returns undefined instead of a Promise), so re-install the mocks
// before every test.
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  // jsdom throws "Not implemented" for canvas 2D contexts (no canvas npm
  // package). The timeline draw pipeline already guards on a null context, so
  // return null to let it skip painting instead of crashing every re-render.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
});

// jsdom does not implement ResizeObserver; the timeline canvas relies on it to
// size itself. A no-op observer keeps the component mounted in tests.
class ResizeObserverMock {
  observe() { /* no-op */ }
  unobserve() { /* no-op */ }
  disconnect() { /* no-op */ }
}
Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});
