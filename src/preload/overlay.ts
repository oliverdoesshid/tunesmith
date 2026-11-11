/**
 * Overlay preload.
 *
 * Runs sandboxed and exposes exactly one method: subscribe to OSD state. There is no
 * `invoke`, no filesystem, no app API, and no inbound IPC channel. The overlay is a
 * display surface, not a second privileged renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS } from '../shared/channels';
import type { OsdState, TuneSmithOsdApi } from '../shared/game/osd';

const api: TuneSmithOsdApi = {
  onState(listener: (state: OsdState) => void): () => void {
    const handler = (_event: unknown, payload: OsdState): void => listener(payload);
    ipcRenderer.on(EVENT_CHANNELS.osdState, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.osdState, handler);
    };
  },
};

contextBridge.exposeInMainWorld('tunesmithOsd', api);
