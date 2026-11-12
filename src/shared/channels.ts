/**
 * IPC channel names, deliberately separated from `./ipc`.
 *
 * The preload script needs these constants but must not bundle the zod request
 * schemas, which are a main-process concern. Keeping the names in a dependency-free
 * module keeps the preload bundle small and its attack surface minimal.
 */

export const IPC_CHANNELS = {
  appInfo: 'app:info',
  appMemory: 'app:memory',
  appElevation: 'app:request-elevation',
  updateStatus: 'tunesmith:update-status',
  updateCheck: 'tunesmith:check-update',
  installUpdate: 'tunesmith:install-update',
  hardwareGet: 'hardware:get',
  presetsList: 'presets:list',
  presetsPlan: 'presets:plan',
  presetsServiceDependencies: 'presets:service-dependencies',
  presetsOpenFolder: 'presets:open-folder',
  safetyPreflight: 'safety:preflight',
  engineApply: 'engine:apply',
  engineSessions: 'engine:sessions',
  engineRollback: 'engine:rollback',
  engineRestoreDefaults: 'engine:restore-defaults',
  enginePostApply: 'engine:post-apply',
  gameStatus: 'game:status',
  gameSetWatching: 'game:set-watching',
  gameSetCryoFreeze: 'game:set-cryo-freeze',
  gameSetInterruptAffinity: 'game:set-interrupt-affinity',
  gameProfiles: 'game:profiles',
  gameLibraries: 'game:libraries',
  gameAddManual: 'game:add-manual',
  gameRemoveManual: 'game:remove-manual',
  gamePickPath: 'game:pick-path',
  gameArtwork: 'game:artwork',
  gameResolveArtwork: 'game:resolve-artwork',
  gameOpenFolder: 'game:open-folder',
  gameLaunch: 'game:launch',
  gameStop: 'game:stop',
  gameOsd: 'game:osd',
  gameOsdSet: 'game:osd-set',
  healthStatus: 'health:status',
  healthCheck: 'health:check',
  healthAcknowledge: 'health:acknowledge',
  healthPin: 'health:pin',
  healthFlushJournals: 'health:flush-journals',
  shaderCacheStatus: 'shader-cache:status',
  shaderCacheScan: 'shader-cache:scan',
  shaderCachePrune: 'shader-cache:prune',
  marketStatus: 'market:status',
  marketInstall: 'market:install',
  marketTelemetryConsent: 'market:telemetry-consent',
} as const;

export const EVENT_CHANNELS = {
  progress: 'engine:progress',
  gameStatus: 'game:status-changed',
  osdState: 'osd:state',
  healthStatus: 'health:status-changed',
  postApplyStatus: 'engine:post-apply-status',
  updateStatus: 'tunesmith:update-status-changed',
} as const;
