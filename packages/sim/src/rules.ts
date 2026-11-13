import type { Point } from './track';

/** Bump when step() behaviour changes in any way that could change a score. */
export const SIM_VERSION = '1.2.0';

export interface CollisionContext {
  /** Last clear cell on the traced path before the obstacle (may be the starting cell). */
  stop: Point;
}

export interface CollisionOutcome {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Extra turns added on top of the move's own turn. */
  penalty: number;
}

export type CollisionRule = (ctx: CollisionContext) => CollisionOutcome;

/**
 * v1: stop on the last clear cell before the wall, lose all speed, and pay 3 penalty turns
 * (the classic vector racing penalty). Large enough that a wall is never a useful brake.
 */
export const stopAtEdge: CollisionRule = ({ stop }) => ({ x: stop.x, y: stop.y, vx: 0, vy: 0, penalty: 3 });

export interface Rules {
  readonly rulesVersion: string;
  readonly onCollision: CollisionRule;
}

export const RULES_V1: Rules = {
  rulesVersion: 'v1',
  onCollision: stopAtEdge,
};
