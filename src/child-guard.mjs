// Child-session guard.
//
// Reused (MIT) from omo-herdr-dag extension.mjs:35 — origin
// https://github.com/jc01rho/omo-herdr-dag @ bb4388d5d046507605e2cf0e8731d2f0ce2f85b7.
// In-process child agents inherit the parent pane environment but do not own its
// UI, so any surface installation, branch read, capture or mask is refused for a
// selected child session. Kept as its own module so the discriminator can be
// unit-tested without loading the SDK.
export const CHILD_SESSION_PATTERN = /[/\\]senpi-task[/\\]children[/\\]/;

export function isChildSession(selectedSessionFile) {
  return typeof selectedSessionFile === 'string' && CHILD_SESSION_PATTERN.test(selectedSessionFile);
}

/**
 * Decide whether a host context may install the observation probe.
 * Order: UI availability, TUI mode, child session, owner presence.
 * Returns a truthful reason, never a silent boolean.
 */
export function hostContextEligible(ctx, host) {
  if (!ctx || ctx.hasUI !== true) return { eligible: false, reason: 'missing-ui' };
  if (ctx.mode !== 'tui') return { eligible: false, reason: 'non-tui-mode' };
  const selectedSessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
  if (isChildSession(selectedSessionFile)) return { eligible: false, reason: 'child-session', selectedSessionFile };
  if (!host || !host.owner) return { eligible: false, reason: 'missing-owner' };
  return { eligible: true, reason: 'eligible', selectedSessionFile };
}
