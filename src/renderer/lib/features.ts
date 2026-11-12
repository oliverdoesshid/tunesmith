/**
 * Workspace module visibility.
 *
 * Visibility is a renderer preference only: hiding a module never disables its engine
 * behaviour, it just removes the panel from the workbench. The tiny persisted record is
 * deliberately independent of the IPC contract.
 */
export const FEATURE_DEFINITIONS = [
  {
    key: 'hud',
    code: '00',
    label: 'Live systems',
    description: 'Affinity, active profile, memory pressure and watchdog state.',
  },
  {
    key: 'hardware',
    code: '01',
    label: 'Machine',
    description: 'CPU, GPU, memory, storage and the hardware signature.',
  },
  {
    key: 'health',
    code: '02',
    label: 'Health watchdog',
    description: 'Passive drift checks, pinned recovery and journal cleanup.',
  },
  {
    key: 'marketplace',
    code: '03',
    label: 'Community presets',
    description: 'Verified catalog with hardware compatibility and install actions.',
  },
  {
    key: 'installed',
    code: '04',
    label: 'Installed presets',
    description: 'Local presets, previews, apply actions and recovery pins.',
  },
  {
    key: 'launcher',
    code: '05',
    label: 'Game library',
    description: 'Detected Steam, Epic, Xbox and GOG titles with quick launch.',
  },
  {
    key: 'gameMode',
    code: '06',
    label: 'Game mode',
    description: 'Focus watcher, profile status, thermal guard and performance OSD.',
  },
  {
    key: 'sessions',
    code: '07',
    label: 'Sessions',
    description: 'Every applied change, interrupted recovery and rollback controls.',
  },
  {
    key: 'shaderCache',
    code: '08',
    label: 'Shader cache',
    description: 'DirectX PSO and GPU driver cache health, with metadata-proven orphan cleanup.',
  },
] as const;

export type FeatureKey = (typeof FEATURE_DEFINITIONS)[number]['key'];
export type FeatureVisibility = Record<FeatureKey, boolean>;

export const DEFAULT_FEATURES: FeatureVisibility = {
  hud: true,
  hardware: true,
  health: true,
  marketplace: true,
  installed: true,
  launcher: true,
  gameMode: true,
  sessions: true,
  shaderCache: true,
};

const STORAGE_KEY = 'tunesmith.workspace.visibility.v1';

export function loadFeatureVisibility(): FeatureVisibility {
  const next = { ...DEFAULT_FEATURES };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return next;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return next;

    const record = parsed as Record<string, unknown>;
    for (const feature of FEATURE_DEFINITIONS) {
      const value = record[feature.key];
      if (typeof value === 'boolean') {
        next[feature.key] = value;
      }
    }
  } catch {
    // A corrupted preference should fall back to the full workbench, not break the UI.
  }

  return next;
}

export function saveFeatureVisibility(features: FeatureVisibility): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(features));
  } catch {
    // Private browsing or a full profile can make localStorage unavailable. The current
    // session still works; only persistence is lost.
  }
}
