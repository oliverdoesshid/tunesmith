/**
 * Display-adapter memory, read straight from the display class registry key.
 *
 * Why this is not part of the CIM snapshot: `Win32_VideoController.AdapterRAM` is a
 * uint32 field and clamps at 4 GiB (a 12 GiB card reports 4,293,918,720 bytes here),
 * while the driver key's `HardwareInformation.qwMemorySize` holds the true size as a
 * REG_QWORD. PowerShell can read it, but a failing pipeline inside a `TryGet` block is
 * silent, which is how a detector ends up silently reporting 4 GiB. `reg.exe` fails with
 * an exit code and a message instead, and its output is stable enough to parse.
 *
 * Only *targeted* queries are used. `reg query <class key> /s` — a recursive dump of every
 * value — hung for more than 15 s on a real machine with three adapters, reproducibly,
 * while `… /v <name> /s` returns in ~30 ms. The class key's `Properties` subtree is the
 * likely reason a wholesale dump is pathological, so it is never requested.
 */
import { oneLine, runExe } from './exec';
import { TuneSmithError } from '../../shared/errors';

/** `{4d36e968-…}` is Display adapters — not storage (`{4d36e967-…}`) or net (`{4d36e972-…}`). */
export const DISPLAY_CLASS_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

/**
 * `reg query` echoes keys as `HKEY_LOCAL_MACHINE\...`, while the query argument uses the
 * `HKLM` shorthand. Compare only the part after the hive or every key is rejected.
 */
const CLASS_SUBPATH = DISPLAY_CLASS_KEY.replace(/^HKLM\\/i, '').toLowerCase();

export interface DisplayAdapterRegEntry {
  /** Full registry path of the per-adapter subkey, e.g. `…\Class\{…}\0000`. */
  driverKey: string;
  description: string;
  vramBytes: number | null;
  matchingDeviceId: string | null;
}

interface Accumulator {
  driverKey: string;
  description: string;
  vramBytes: number | null;
  matchingDeviceId: string | null;
}

const KEY_HEADER = /^(HKEY_[A-Z_]+)\\(.+)$/;
const HIVE_PREFIX = /^(?:HKLM|HKEY_LOCAL_MACHINE)\\/i;

/** `reg query` prints value lines with a four-space indent and column padding. */
const VALUE_LINE = /^ {4}(.+?) {2,}(REG_[A-Z_]+)(?: {2,}(.*))?$/;

function decodeRegData(type: string, data: string): string | number | null {
  const raw = data.trim();
  if (type === 'REG_DWORD' || type === 'REG_QWORD') {
    const hex = /^0x([0-9a-f]+)$/i.exec(raw);
    if (hex?.[1]) {
      const parsed = Number.parseInt(hex[1], 16);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    const decimal = /^\d+$/.exec(raw);
    if (decimal) {
      const parsed = Number.parseInt(decimal[0], 10);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  }
  return raw;
}

/**
 * Parse `reg query <display class key> /s`.
 *
 * Exported for tests: this parser is the difference between reporting 12 GiB and 4 GiB,
 * and `reg.exe` output has been stable for two decades, so a fixture is worth keeping.
 */
export function parseAdapterDump(stdout: string): DisplayAdapterRegEntry[] {
  const entries = new Map<string, Accumulator>();
  let current: Accumulator | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const header = KEY_HEADER.exec(line);
    if (header) {
      const driverKey = `${header[1]}\\${header[2]}`;
      const subPath = driverKey.replace(HIVE_PREFIX, '').toLowerCase();

      // Only the per-adapter instance keys (`…\0000`) carry the values we want;
      // the class root, `Configuration` and `Properties` subkeys are ignored.
      const prefix = `${CLASS_SUBPATH}\\`;
      const leaf = subPath.startsWith(prefix) ? subPath.slice(prefix.length) : null;

      if (leaf !== null && /^[0-9]{4}$/.test(leaf)) {
        // Targeted queries are concatenated before parsing, so a key that appears in both
        // must accumulate fields instead of being reset by the second occurrence.
        const id = driverKey.toLowerCase();
        current = entries.get(id) ?? { driverKey, description: '', vramBytes: null, matchingDeviceId: null };
        entries.set(id, current);
      } else {
        current = null;
      }
      continue;
    }

    if (current === null) continue;

    const value = VALUE_LINE.exec(line);
    if (!value) continue;

    const name = (value[1] ?? '').trim();
    const type = value[2] ?? '';
    const decoded = decodeRegData(type, value[3] ?? '');

    if (name === 'DriverDesc' && typeof decoded === 'string') {
      current.description = decoded;
    } else if (name === 'HardwareInformation.qwMemorySize' && typeof decoded === 'number') {
      current.vramBytes = decoded > 0 ? decoded : null;
    } else if (name === 'MatchingDeviceId' && typeof decoded === 'string') {
      current.matchingDeviceId = decoded;
    }
  }

  return [...entries.values()]
    .filter((entry) => entry.description.length > 0)
    .map(({ driverKey, description, vramBytes, matchingDeviceId }) => ({
      driverKey,
      description,
      vramBytes,
      matchingDeviceId,
    }));
}

/** One value, across every adapter subkey. A missing value is not an error. */
async function queryAdapterValue(valueName: string): Promise<string> {
  const result = await runExe('reg.exe', ['query', DISPLAY_CLASS_KEY, '/v', valueName, '/s'], { timeoutMs: 20_000 });
  if (result.code !== 0) {
    if (/unable to find/i.test(result.stderr)) return '';
    throw new TuneSmithError(
      'capture-failed',
      `Could not read ${valueName} from the display adapter keys`,
      oneLine(result.stderr),
    );
  }
  return result.stdout;
}

export async function listDisplayAdapters(): Promise<DisplayAdapterRegEntry[]> {
  const [memory, descriptions] = await Promise.all([
    queryAdapterValue('HardwareInformation.qwMemorySize'),
    queryAdapterValue('DriverDesc'),
  ]);
  return parseAdapterDump(`${memory}\n${descriptions}`);
}
