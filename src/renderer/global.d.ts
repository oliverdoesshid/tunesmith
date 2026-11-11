import type { TuneSmithApi } from '../shared/ipc';
import type { TuneSmithOsdApi } from '../shared/game/osd';

declare global {
  interface Window {
    /** Injected by the preload bridge. Absent when the UI runs in a plain browser. */
    tunesmith?: TuneSmithApi;
    /** Injected only into the display-only performance overlay window. */
    tunesmithOsd?: TuneSmithOsdApi;
  }
}

export {};
