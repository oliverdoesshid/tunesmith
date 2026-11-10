import { describe, expect, it } from 'vitest';
import { parseAdapterDump } from '../src/main/platform/display-adapters';

// Trimmed but faithful `reg query "<display class>" /s` output from a real machine:
// the 12 GiB card reports 12884901888 here while WMI clamps it to 4 GiB.
const DUMP = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000
    DriverDesc    REG_SZ    NVIDIA GeForce RTX 3060
    HardwareInformation.qwMemorySize    REG_QWORD    0x300000000
    MatchingDeviceId    REG_SZ    pci\\ven_10de&dev_2487&subsys_397d1462
    ProviderName    REG_SZ    NVIDIA

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0001
    DriverDesc    REG_SZ    Virtual Desktop Monitor
    MatchingDeviceId    REG_SZ    Root\\vdvmd

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Storage\\Class\\{4d36e967-e325-11ce-bfc1-08002be10318}\\0000
    DriverDesc    REG_SZ    KINGSTON SNV2S1000G
`;

describe('parseAdapterDump', () => {
  it('reads true VRAM from the driver key instead of the 32-bit WMI field', () => {
    const adapters = parseAdapterDump(DUMP);
    const nvidia = adapters.find((a) => a.description.includes('RTX 3060'));
    expect(nvidia?.vramBytes).toBe(12_884_901_888);
    expect(nvidia?.vramBytes).toBe(12 * 1024 ** 3);
  });

  it('keeps adapters that expose no memory value', () => {
    const adapters = parseAdapterDump(DUMP);
    const virtualAdapter = adapters.find((a) => a.description === 'Virtual Desktop Monitor');
    expect(virtualAdapter).toBeDefined();
    expect(virtualAdapter?.vramBytes).toBeNull();
    expect(virtualAdapter?.matchingDeviceId).toBe('Root\\vdvmd');
  });

  it('ignores the storage class key that appears in the same hive', () => {
    const descriptions = parseAdapterDump(DUMP).map((a) => a.description);
    expect(descriptions).not.toContain('KINGSTON SNV2S1000G');
    expect(descriptions).toHaveLength(2);
  });

  it('parses decimal data and rejects unsafe QWORD values', () => {
    const dump = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000
    DriverDesc    REG_SZ    Card A
    HardwareInformation.qwMemorySize    REG_QWORD    8589934592

HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0001
    DriverDesc    REG_SZ    Card B
    HardwareInformation.qwMemorySize    REG_QWORD    0xFFFFFFFFFFFFFFFF
`;
    const adapters = parseAdapterDump(dump);
    expect(adapters.find((a) => a.description === 'Card A')?.vramBytes).toBe(8_589_934_592);
    expect(adapters.find((a) => a.description === 'Card B')?.vramBytes).toBeNull();
  });

  it('merges two targeted queries that repeat the same driver key', () => {
    // The production path issues one query per value and concatenates the results, so the
    // same key header appears twice and must accumulate rather than reset.
    const lines = DUMP.split('\n');
    const memoryOnly = lines.filter((l) => l.startsWith('HKEY_') || l.includes('qwMemorySize')).join('\n');
    const descriptionOnly = lines.filter((l) => l.startsWith('HKEY_') || l.includes('DriverDesc')).join('\n');

    const merged = parseAdapterDump(`${memoryOnly}\n${descriptionOnly}`);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => a.description.includes('RTX 3060'))?.vramBytes).toBe(12 * 1024 ** 3);
  });

  it('returns nothing for empty or unrelated output', () => {
    expect(parseAdapterDump('')).toEqual([]);
    expect(parseAdapterDump('ERROR: The system was unable to find the specified registry key.')).toEqual([]);
  });
});
