export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

export const ARROW_SEQUENCES: Record<ArrowDirection, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

/**
 * Turns finger travel on the arrow pad into arrow presses: one press per
 * `stepPx` along the axis the finger moved further on. Returns the presses and
 * the travel left over for the next move. Travel on the other axis is dropped,
 * so a slightly crooked swipe does not leak into sideways presses.
 */
export function arrowsForTravel(
  dx: number,
  dy: number,
  stepPx: number,
): { direction: ArrowDirection | null; count: number; restX: number; restY: number } {
  if (!(stepPx > 0)) {
    return { direction: null, count: 0, restX: 0, restY: 0 };
  }

  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const travel = horizontal ? dx : dy;
  const count = Math.trunc(Math.abs(travel) / stepPx);
  if (count === 0) {
    return { direction: null, count: 0, restX: dx, restY: dy };
  }

  const direction: ArrowDirection = horizontal ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  const rest = travel - Math.sign(travel) * count * stepPx;
  return { direction, count, restX: horizontal ? rest : 0, restY: horizontal ? 0 : rest };
}
