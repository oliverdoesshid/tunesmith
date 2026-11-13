/**
 * Overlay placement is pure so it can be tested without Electron or a screen.
 * The game rectangle and display rectangle are already in display-independent pixels.
 */

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const OSD_WIDTH = 360;
export const OSD_HEIGHT = 214;
export const OSD_MARGIN = 18;

/**
 * Anchor the OSD to the game window's top-left, but clamp it to the display so a
 * window that is partly off-screen (or larger than its display) cannot put the OSD
 * where the user can never see it.
 */
export function placeOverlay(
  game: WindowBounds,
  display: DisplayBounds,
  width = OSD_WIDTH,
  height = OSD_HEIGHT,
  margin = OSD_MARGIN,
): OverlayRect {
  const minX = display.x + margin;
  const minY = display.y + margin;
  const maxX = display.x + display.width - width - margin;
  const maxY = display.y + display.height - height - margin;

  const x = Math.max(minX, Math.min(game.left + margin, Math.max(minX, maxX)));
  const y = Math.max(minY, Math.min(game.top + margin, Math.max(minY, maxY)));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
