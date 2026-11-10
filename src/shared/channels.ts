/**
 * IPC channel names, deliberately separated from `./ipc`.
 *
 * The preload script needs these constants but must not bundle the zod request
 * schemas, which are a main-process concern. Keeping the names in a dependency-free
 * module keeps the preload bundle small and its attack surface minimal.
 */

export const IPC_CHANNELS = {
  appInfo: 'app:info',
  appElevation: 'app:request-elevation',
  hardwareGet: 'hardware:get',
  presetsList: 'presets:list',
  presetsPlan: 'presets:plan',
  presetsOpenFolder: 'presets:open-folder',
  safetyPreflight: 'safety:preflight',
  engineApply: 'engine:apply',
  engineSessions: 'engine:sessions',
  engineRollback: 'engine:rollback',
  engineRestoreDefaults: 'engine:restore-defaults',
  gameStatus: 'game:status',
  gameSetWatching: 'game:set-watching',
  gameProfiles: 'game:profiles',
  gameStop: 'game:stop',
} as const;

export const EVENT_CHANNELS = {
  progress: 'engine:progress',
  gameStatus: 'game:status-changed',
} as const;
