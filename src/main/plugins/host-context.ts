/**
 * Read-only snapshot given to community extensions.
 *
 * This adapter is intentionally not configurable from a plugin: the logical key map is
 * fixed here, each probe is targeted (no recursive registry dumps), and failures become
 * `null`/`unknown` observations rather than exceptions or elevated retries.
 */
import {
  PLUGIN_REGISTRY_KEYS,
  PLUGIN_SERVICE_IDS,
  type PluginContext,
  type PluginRegistryKey,
  type PluginRegistryValue,
  type PluginServiceId,
  type PluginServiceStartType,
  type PluginServiceState,
} from '../../shared/plugins/api';
import { readValue } from '../platform/registry';
import { readServiceRegistry } from '../platform/service-registry';

interface RegistryTarget {
  hive: 'HKCU' | 'HKLM';
  path: string;
  name: string;
}

const REGISTRY_TARGETS: Readonly<Record<PluginRegistryKey, RegistryTarget>> = {
  'game-dvr-enabled': { hive: 'HKCU', path: 'System\\GameConfigStore', name: 'GameDVR_Enabled' },
  'game-mode-enabled': { hive: 'HKCU', path: 'SOFTWARE\\Microsoft\\GameBar', name: 'AutoGameModeEnabled' },
  'system-responsiveness': {
    hive: 'HKLM',
    path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile',
    name: 'SystemResponsiveness',
  },
  'network-throttling-index': {
    hive: 'HKLM',
    path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile',
    name: 'NetworkThrottlingIndex',
  },
  'win32-priority-separation': {
    hive: 'HKLM',
    path: 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl',
    name: 'Win32PrioritySeparation',
  },
  'hardware-gpu-scheduling': {
    hive: 'HKLM',
    path: 'SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers',
    name: 'HwSchMode',
  },
};

const SERVICE_NAMES: Readonly<Record<PluginServiceId, string>> = {
  sysmain: 'SysMain',
  diagtrack: 'DiagTrack',
  'wer-svc': 'WerSvc',
  'xbox-game-save': 'XblGameSave',
  gameinput: 'GameInputSvc',
};

function startType(value: string | undefined): PluginServiceStartType {
  switch (value) {
    case 'Boot':
    case 'System':
    case 'Auto':
    case 'Manual':
    case 'Disabled':
      return value;
    default:
      return 'Unknown';
  }
}

/** Missing or unreadable values are explicit observations, never silently guessed. */
function emptyContext(now: string): PluginContext {
  return { registry: {}, services: {}, generatedAt: now };
}

export async function readPluginHostContext(now = new Date().toISOString()): Promise<PluginContext> {
  const context = emptyContext(now);

  const registryPairs = await Promise.all(
    PLUGIN_REGISTRY_KEYS.map(async (key) => {
      const target = REGISTRY_TARGETS[key];
      try {
        const snapshot = await readValue(target.hive, target.path, target.name);
        if (!snapshot.exists) return [key, null] as const;
        return [key, snapshot.data] as const;
      } catch {
        return [key, null] as const;
      }
    }),
  );
  for (const [key, value] of registryPairs) {
    context.registry[key] = value satisfies PluginRegistryValue;
  }

  try {
    const services = await readServiceRegistry();
    const byName = new Map(services.map((entry) => [entry.name.toLowerCase(), entry]));
    for (const id of PLUGIN_SERVICE_IDS) {
      const entry = byName.get(SERVICE_NAMES[id].toLowerCase());
      const state: PluginServiceState = entry === undefined
        ? { present: false, startType: 'Unknown' }
        : { present: true, startType: startType(entry.start) };
      context.services[id] = state;
    }
  } catch {
    for (const id of PLUGIN_SERVICE_IDS) {
      context.services[id] = { present: false, startType: 'Unknown' };
    }
  }

  return context;
}
