/**
 * PowerShell bodies and C# interop used by the game engine.
 *
 * Everything here is static, code-owned text. Profile data reaches it only as:
 *   - integer pids and masks (already validated numbers)
 *   - image names constrained by `PROCESS_NAME_RE`
 *   - an absolute executable path validated by the game schema
 * Each is injected through `psQuote` (single-quote escaped) inside a base64-encoded
 * command, so no Windows argv quoting rule can reinterpret it.
 */

/**
 * Foreground window + watched processes, in one long-lived loop.
 *
 * A persistent process rather than a spawn per tick: polling from Node means paying
 * PowerShell startup (~100 ms of CPU) every couple of seconds, which is indefensible in
 * a tool that claims to make a machine faster. This loop idles in `Start-Sleep`.
 */
export const WATCHER_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TsForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int GetPackageFamilyName(IntPtr process, ref uint length, System.Text.StringBuilder name);

  /// Reads the AppContainer package identity for a pid. Returns null for unpackaged
  /// (Win32 / Steam / Epic) processes, which is the common case.
  public static string FamilyName(int pid) {
    const uint QUERY_LIMITED = 0x1000;
    IntPtr handle = OpenProcess(QUERY_LIMITED, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      uint length = 256;
      System.Text.StringBuilder buffer = new System.Text.StringBuilder(256);
      int result = GetPackageFamilyName(handle, ref length, buffer);
      return result == 0 ? buffer.ToString() : null;
    } catch { return null; } finally { CloseHandle(handle); }
  }
}
"@ | Out-Null

$watch = @(WATCH_NAMES)
$interval = INTERVAL_MS

while ($true) {
  $foreground = $null
  try {
    $handle = [TsForeground]::GetForegroundWindow()
    if ($handle -ne [IntPtr]::Zero) {
      $targetPid = 0
      [void][TsForeground]::GetWindowThreadProcessId($handle, [ref]$targetPid)
      if ($targetPid -gt 0) {
        $proc = Get-Process -Id $targetPid -ErrorAction Stop
        $path = $null
        try { $path = $proc.Path } catch { $path = $null }
        $foreground = [pscustomobject]@{
          pid               = $proc.Id
          exe               = ($proc.ProcessName.ToLower() + '.exe')
          path              = $path
          title             = [string]$proc.MainWindowTitle
          packageFamilyName = [TsForeground]::FamilyName($targetPid)
        }
      }
    }
  } catch { $foreground = $null }

  $running = @()
  try {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $watch -contains ($_.ProcessName.ToLower() + '.exe')
      } | ForEach-Object {
        [pscustomobject]@{ pid = $_.Id; exe = ($_.ProcessName.ToLower() + '.exe') }
      })
  } catch { $running = @() }

  [Console]::Out.WriteLine(([pscustomobject]@{
    foreground = $foreground
    running    = $running
  } | ConvertTo-Json -Depth 4 -Compress))
  [Console]::Out.Flush()

  Start-Sleep -Milliseconds $interval
}
`;

/**
 * Suspend or resume a batch of pids. `ntdll` has no managed equivalent, and doing it in
 * one call amortises the ~500 ms `Add-Type` compile across every background rule.
 */
export const SUSPEND_BATCH_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TsSuspend {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtResumeProcess(IntPtr handle);
  const uint SUSPEND_RESUME = 0x0800;
  public static bool Suspend(int pid) {
    IntPtr h = OpenProcess(SUSPEND_RESUME, false, pid);
    if (h == IntPtr.Zero) return false;
    try { return NtSuspendProcess(h) == 0; } finally { CloseHandle(h); }
  }
  public static bool Resume(int pid) {
    IntPtr h = OpenProcess(SUSPEND_RESUME, false, pid);
    if (h == IntPtr.Zero) return false;
    try { return NtResumeProcess(h) == 0; } finally { CloseHandle(h); }
  }
}
"@ | Out-Null

$mode = MODE
$results = @()
foreach ($processId in @(PIDS)) {
  try {
    $ok = if ($mode -eq 'suspend') { [TsSuspend]::Suspend($processId) } else { [TsSuspend]::Resume($processId) }
    $results += [pscustomobject]@{ pid = $processId; ok = [bool]$ok }
  } catch {
    $results += [pscustomobject]@{ pid = $processId; ok = $false }
  }
}

[pscustomobject]@{ results = @($results) } | ConvertTo-Json -Depth 4 -Compress
`;

/**
 * Standby-list purge (`NtSetSystemInformation` / `SystemMemoryListInformation` 80,
 * command 4). Requires `SeProfileSingleProcessPrivilege`, i.e. an elevated process.
 *
 * Deliberately not called anywhere by default: see docs/GAME-ENGINE.md.
 */
export const PURGE_STANDBY_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TsMemory {
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokPriv1Luid state, int len, IntPtr prev, IntPtr retLen);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtSetSystemInformation(int infoClass, IntPtr info, int length);

  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  struct TokPriv1Luid { public int Count; public long Luid; public int Attr; }

  const int TOKEN_ADJUST_PRIVILEGES = 0x0020;
  const int TOKEN_QUERY = 0x0008;
  const int SE_PRIVILEGE_ENABLED = 0x0002;
  const int SYSTEM_MEMORY_LIST_INFORMATION = 80;
  const int MEMORY_PURGE_STANDBY_LIST = 4;

  public static bool Purge() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token)) return false;
    try {
      long luid;
      if (!LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", out luid)) return false;
      TokPriv1Luid state = new TokPriv1Luid();
      state.Count = 1; state.Luid = luid; state.Attr = SE_PRIVILEGE_ENABLED;
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) return false;
      IntPtr command = Marshal.AllocHGlobal(4);
      try {
        Marshal.WriteInt32(command, MEMORY_PURGE_STANDBY_LIST);
        return NtSetSystemInformation(SYSTEM_MEMORY_LIST_INFORMATION, command, 4) == 0;
      } finally { Marshal.FreeHGlobal(command); }
    } finally { CloseHandle(token); }
  }
}
"@ | Out-Null

$ok = $false
try { $ok = [TsMemory]::Purge() } catch { $ok = $false }
[pscustomobject]@{ ok = [bool]$ok } | ConvertTo-Json -Compress
`;

/**
 * Logical-processor topology via `GetSystemCpuSetInformation` (the only documented
 * source of `EfficiencyClass`, which is how Windows itself distinguishes P-cores from
 * E-cores).
 *
 * The buffer is walked with bounds checks against the reported length: a bogus `Size`
 * field must not walk off the allocation.
 */
export const TOPOLOGY_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TsCpuSet {
  [StructLayout(LayoutKind.Sequential)]
  struct CpuSetInfo {
    public uint Size; public int Type; public uint Id; public ushort Group;
    public byte LogicalProcessorIndex; public byte CoreIndex; public byte LastLevelCacheIndex;
    public byte NumaNodeIndex; public byte EfficiencyClass; public byte AllFlags; public uint AllocationTag;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint returned, IntPtr process, uint flags);

  public static string[] Read() {
    uint needed = 0;
    GetSystemCpuSetInformation(IntPtr.Zero, 0, out needed, IntPtr.Zero, 0);
    if (needed == 0 || needed > 1024 * 128) return new string[0];

    IntPtr buffer = Marshal.AllocHGlobal((int)needed);
    try {
      uint returned = 0;
      if (!GetSystemCpuSetInformation(buffer, needed, out returned, IntPtr.Zero, 0)) return new string[0];

      List<string> rows = new List<string>();
      int offset = 0;
      while (offset + 24 <= (int)returned && rows.Count < 4096) {
        CpuSetInfo info = (CpuSetInfo)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64() + offset), typeof(CpuSetInfo));
        if (info.Size < 24) break;
        if (info.Type == 0) {
          rows.Add(string.Join(",",
            info.Group.ToString(),
            info.LogicalProcessorIndex.ToString(),
            info.CoreIndex.ToString(),
            info.EfficiencyClass.ToString()));
        }
        offset += (int)info.Size;
      }
      return rows.ToArray();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
"@ | Out-Null

$rows = @([TsCpuSet]::Read() | ForEach-Object {
  $parts = $_ -split ','
  [pscustomobject]@{
    group      = [int]$parts[0]
    logical    = [int]$parts[1]
    core       = [int]$parts[2]
    efficiency = [int]$parts[3]
  }
})

[pscustomobject]@{ cpusets = @($rows) } | ConvertTo-Json -Depth 4 -Compress
`;

/**
 * Per-group thread affinity, for machines with more than one processor group.
 *
 * `SetProcessAffinityMask` only affects a process's primary group, so above 64
 * processors the only supported mechanism is `SetThreadGroupAffinity` on every thread.
 * Masks are 64-bit values supplied as decimal literals from validated hex strings; the
 * script never receives a mask it could interpret as anything but a number.
 *
 * Placeholders: `PID`, `MASKS` (comma-separated UInt64), `GROUPS` (comma-separated int),
 * and `PRIORITY_LINE`.
 */
/**
 * One read-only hardware telemetry sample, from every source Windows exposes without
 * third-party drivers of our own.
 *
 * The script returns *candidates*, not a decision. `normaliseTelemetry` in TS picks the
 * best available source, so the preference order is unit-tested instead of living in
 * PowerShell. What each source covers:
 *
 *   - AC/battery: `GetSystemPowerStatus`, with `Win32_Battery` as a fallback when the
 *     C# compile is unavailable. Present on desktops (AC, no battery) and laptops alike.
 *   - LibreHardwareMonitor / OpenHardwareMonitor: when either is already running, its WMI
 *     namespace exposes true package temperatures, GPU temperatures for NVIDIA, AMD and
 *     Intel, and real power draw. Read-only; absence is normal and not an error.
 *   - ACPI thermal zones and the thermal-zone perf counter: present on most laptops, many
 *     desktops expose no zone at all. These are chassis/zone readings, not a package sensor.
 *   - `nvidia-smi`: NVIDIA only, including the legacy NVSMI install path.
 *   - Battery discharge rate: laptops on battery only.
 */
export const TELEMETRY_SCRIPT = String.raw`
$onAc = $null
$batteryPercent = $null
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TsPowerStatus {
  [StructLayout(LayoutKind.Sequential)]
  public struct SYSTEM_POWER_STATUS {
    public byte ACLineStatus;
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public int BatteryLifeTime;
    public int BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
}
"@ | Out-Null
  $status = New-Object TsPowerStatus+SYSTEM_POWER_STATUS
  if ([TsPowerStatus]::GetSystemPowerStatus([ref]$status)) {
    if ($status.ACLineStatus -eq 1) { $onAc = $true }
    elseif ($status.ACLineStatus -eq 0) { $onAc = $false }
    if ($status.BatteryLifePercent -le 100) { $batteryPercent = [int]$status.BatteryLifePercent }
  }
} catch { }

# Fallback where Add-Type is unavailable: Win32_Battery still separates AC from discharging.
if ($null -eq $onAc) {
  try {
    $batteryInfo = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $batteryInfo) {
      if ($batteryInfo.BatteryStatus -eq 1) { $onAc = $false }
      elseif ($batteryInfo.BatteryStatus -eq 2) { $onAc = $true }
      if ($batteryInfo.EstimatedChargeRemaining -ge 0) { $batteryPercent = [int]$batteryInfo.EstimatedChargeRemaining }
    }
  } catch { }
}

function Get-MonitorSnapshot([string]$namespace) {
  try {
    $sensors = @(Get-CimInstance -Namespace $namespace -ClassName Sensor -ErrorAction Stop)
  } catch { return $null }
  if ($sensors.Count -eq 0) { return $null }

  $cpuTemps = @($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and [double]$_.Value -gt 0 -and [string]$_.Identifier -match '/(intelcpu|amdcpu|cpu)/' })
  $gpuTemps = @($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and [double]$_.Value -gt 0 -and [string]$_.Identifier -match '/gpu' })
  $cpuPower = @($sensors | Where-Object { $_.SensorType -eq 'Power' -and [double]$_.Value -gt 0 -and [string]$_.Identifier -match '/(intelcpu|amdcpu|cpu)/' })
  $gpuPower = @($sensors | Where-Object { $_.SensorType -eq 'Power' -and [double]$_.Value -gt 0 -and [string]$_.Identifier -match '/gpu' })

  $cpuTempC = $null
  $preferred = @($cpuTemps | Where-Object { [string]$_.Name -match 'Package|Tctl' })
  if ($preferred.Count -eq 0) { $preferred = $cpuTemps }
  if ($preferred.Count -gt 0) { $cpuTempC = ($preferred | ForEach-Object { [double]$_.Value } | Measure-Object -Maximum).Maximum }

  $gpuTempC = $null
  $preferred = @($gpuTemps | Where-Object { [string]$_.Name -eq 'GPU Core' })
  if ($preferred.Count -eq 0) { $preferred = $gpuTemps }
  if ($preferred.Count -gt 0) { $gpuTempC = ($preferred | ForEach-Object { [double]$_.Value } | Measure-Object -Maximum).Maximum }

  $powerDrawW = $null
  $preferred = @($cpuPower | Where-Object { [string]$_.Name -match 'Package' })
  if ($preferred.Count -eq 0) { $preferred = $cpuPower }
  if ($preferred.Count -eq 0) { $preferred = $gpuPower }
  if ($preferred.Count -gt 0) { $powerDrawW = ($preferred | ForEach-Object { [double]$_.Value } | Measure-Object -Maximum).Maximum }

  return [pscustomobject]@{ cpuTempC = $cpuTempC; gpuTempC = $gpuTempC; powerDrawW = $powerDrawW }
}

$acpiCpuTempC = $null
try {
  $zones = @(Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)
  $readings = @($zones | ForEach-Object { [double]$_.CurrentTemperature } | Where-Object { $_ -gt 0 })
  if ($readings.Count -gt 0) {
    $acpiCpuTempC = [math]::Round((($readings | Measure-Object -Maximum).Maximum / 10.0) - 273.15, 1)
  }
} catch { }

$counterCpuTempC = $null
try {
  $rows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop)
  $readings = @($rows | ForEach-Object { [double]$_.HighPrecisionTemperature } | Where-Object { $_ -gt 0 })
  if ($readings.Count -gt 0) {
    $counterCpuTempC = [math]::Round((($readings | Measure-Object -Maximum).Maximum / 10.0) - 273.15, 1)
  }
} catch { }

$nvidiaGpuTempC = $null
try {
  $candidates = @(
    (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source,
    (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'),
    (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($tool in $candidates) {
    $value = @(& $tool --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null) | Select-Object -First 1
    $parsed = 0.0
    if ([double]::TryParse([string]$value, [ref]$parsed) -and $parsed -gt 0) {
      $nvidiaGpuTempC = [math]::Round($parsed, 1)
      break
    }
  }
} catch { }

$batteryPowerW = $null
if ($onAc -eq $false) {
  try {
    $battery = Get-CimInstance -Namespace 'root/wmi' -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $battery -and $battery.DischargeRate -gt 0) {
      $batteryPowerW = [math]::Round($battery.DischargeRate / 1000.0, 1)
    }
  } catch { }
}

[pscustomobject]@{
  onAc             = $onAc
  batteryPercent   = $batteryPercent
  lhm              = (Get-MonitorSnapshot 'root/LibreHardwareMonitor')
  ohm              = (Get-MonitorSnapshot 'root/OpenHardwareMonitor')
  acpiCpuTempC     = $acpiCpuTempC
  counterCpuTempC  = $counterCpuTempC
  nvidiaGpuTempC   = $nvidiaGpuTempC
  batteryPowerW    = $batteryPowerW
} | ConvertTo-Json -Compress -Depth 6
`;

export const GROUP_AFFINITY_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class TsGroupAffinity {
  [StructLayout(LayoutKind.Sequential)]
  public struct GROUP_AFFINITY {
    public UIntPtr Mask;
    public ushort Group;
    public ushort Reserved1;
    public ushort Reserved2;
    public ushort Reserved3;
  }

  [DllImport("kernel32.dll")] static extern ushort GetActiveProcessorGroupCount();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetThreadGroupAffinity(IntPtr thread, ref GROUP_AFFINITY affinity, IntPtr previous);

  public static int Apply(int pid, ulong[] masks, int[] groups) {
    ushort groupCount = GetActiveProcessorGroupCount();
    Process process = Process.GetProcessById(pid);
    int applied = 0;
    foreach (ProcessThread thread in process.Threads) {
      IntPtr handle = OpenThread(0x0020 | 0x0040, false, (uint)thread.Id);
      if (handle == IntPtr.Zero) continue;
      try {
        for (int i = 0; i < groups.Length && i < masks.Length; i++) {
          if (groups[i] < 0 || groups[i] >= groupCount) continue;
          GROUP_AFFINITY affinity = new GROUP_AFFINITY();
          affinity.Mask = new UIntPtr(masks[i]);
          affinity.Group = (ushort)groups[i];
          if (SetThreadGroupAffinity(handle, ref affinity, IntPtr.Zero)) applied++;
        }
      } finally { CloseHandle(handle); }
    }
    return applied;
  }
}
"@ | Out-Null

$targetPid = PID
try {
  $proc = Get-Process -Id $targetPid -ErrorAction Stop
  $masks = [uint64[]]@(MASKS)
  $groups = [int[]]@(GROUPS)
  $applied = [TsGroupAffinity]::Apply($targetPid, $masks, $groups)
  if ($applied -le 0) { throw 'no thread accepted the group affinity' }
  PRIORITY_LINE
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
[pscustomobject]@{ ok = $true; threads = $applied; priorityApplied = $priorityApplied } | ConvertTo-Json -Compress
`;
