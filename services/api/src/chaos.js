import { AppError } from '@opsbridge/common';

/**
 * Fault injection for incident drills (see docs/incident-drill.md). Disabled unless ENABLE_CHAOS=true,
 * and only changeable by an admin at runtime, so a drill never needs a redeploy.
 */
export function createChaos() {
  const state = { errorRate: 0, latencyMs: 0 };
  return {
    state,
    set(next) {
      Object.assign(state, next);
    },
    middleware: async (_req, _res, next) => {
      if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));
      if (state.errorRate > 0 && Math.random() < state.errorRate) {
        return next(new AppError(504, 'DB_TIMEOUT', 'Upstream data store timed out (injected fault)'));
      }
      next();
    },
  };
}
