import { installDisplayBridge, bindDisplayBridgeSignals } from '../../src/display-bridge.mjs';

export const DISPLAY_HOST_KEY = Symbol.for('omo-herdr-todo.display-host');

// Real ResourceLoader regular extension: always AFTER stock builtin Todo.
export default function displayBridgeFixture(pi) {
  const fixture = globalThis[DISPLAY_HOST_KEY];
  pi.on('session_start', (_event, ctx) => {
    fixture.bridge?.remove();
    fixture.advance(ctx);
    fixture.startupWidget = fixture.host.surface.nativeWidget();
    fixture.startupCalls = fixture.host.surface.nativeCalls.length;
    fixture.bridge = installDisplayBridge(ctx, fixture.adapter, { environment: fixture.environment });
  });
  // Advance scope before our post-tree observer, without mutating the session.
  pi.on('session_tree', (_event, ctx) => fixture.advance(ctx));
  fixture.unbind = bindDisplayBridgeSignals(pi, () => fixture.bridge);
}
