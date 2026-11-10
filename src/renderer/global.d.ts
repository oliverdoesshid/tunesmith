import type { TuneSmithApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Injected by the preload bridge. Absent when the UI runs in a plain browser. */
    tunesmith?: TuneSmithApi;
  }
}

export {};
