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
 * Foreground window observer.
 *
 * There is no polling loop here. The old watcher woke a CLR process every two seconds to
 * call Get-Process and GetForegroundWindow. This observer installs WinEvent hooks, prints
 * the current foreground identity once, and then blocks in GetMessage: Windows wakes it
 * only when focus, a title, or the foreground window rectangle changes.
 *
 * Process presence is intentionally not part of this script. It is read separately with
 * `tasklist /FO CSV /NH`, which is a small native executable rather than a CLR host.
 */
export const FOREGROUND_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TsForeground {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG message, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG message);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder name);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
  }

  delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
  const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
  const int OBJID_WINDOW = 0;
  const int CHILDID_SELF = 0;
  const uint QUERY_LIMITED_INFORMATION = 0x1000;

  static readonly WinEventDelegate Callback = new WinEventDelegate(OnEvent);
  static readonly object Sync = new object();
  static readonly Stopwatch Clock = Stopwatch.StartNew();
  static readonly Timer Throttle = new Timer(OnThrottle, null, Timeout.Infinite, Timeout.Infinite);

  static IntPtr foregroundHook;
  static IntPtr locationHook;
  static IntPtr nameHook;
  static int scheduled;
  static int dirty;
  static long lastEmitAt;
  static bool lastEmitted;
  static int lastPid;
  static string lastExe;
  static string lastPath;
  static string lastTitle;
  static string lastPackage;
  static bool lastHasWindow;
  static int lastLeft;
  static int lastTop;
  static int lastWidth;
  static int lastHeight;

  /// Per-monitor DPI awareness keeps GetWindowRect in physical pixels on scaled displays;
  /// Electron's screenToDipRect then converts once into the coordinates it uses.
  public static void EnableDpiAwareness() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  }

  public static void Run() {
    try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
    EnableDpiAwareness();
    foregroundHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, Callback, 0, 0, 0);
    locationHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, Callback, 0, 0, 0);
    nameHook = SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, Callback, 0, 0, 0);
    if (foregroundHook == IntPtr.Zero || locationHook == IntPtr.Zero || nameHook == IntPtr.Zero) {
      throw new InvalidOperationException("Could not install foreground window hooks.");
    }

    Emit();

    MSG message;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref message);
      DispatchMessage(ref message);
    }
  }

  static void OnEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    try {
      if (eventType == EVENT_OBJECT_LOCATIONCHANGE || eventType == EVENT_OBJECT_NAMECHANGE) {
        if (idObject != OBJID_WINDOW || idChild != CHILDID_SELF) return;
        if (hwnd != GetForegroundWindow()) return;
      } else if (eventType != EVENT_SYSTEM_FOREGROUND) {
        return;
      }
      RequestEmit();
    } catch { }
  }

  /// Coalesce a drag/resize burst into at most one line every 80 ms. Without this, a
  /// window drag would turn into hundreds of JSON lines and wake the main process for each.
  static void RequestEmit() {
    Interlocked.Exchange(ref dirty, 1);
    if (Interlocked.CompareExchange(ref scheduled, 1, 0) != 0) return;

    long elapsed = Clock.ElapsedMilliseconds - Interlocked.Read(ref lastEmitAt);
    int wait = elapsed >= 80 ? 0 : (int)(80 - elapsed);
    Throttle.Change(wait, Timeout.Infinite);
  }

  static void OnThrottle(object state) {
    Interlocked.Exchange(ref scheduled, 0);
    if (Interlocked.Exchange(ref dirty, 0) == 1) Emit();
  }

  static void Emit() {
    lock (Sync) {
      Interlocked.Exchange(ref lastEmitAt, Clock.ElapsedMilliseconds);

      IntPtr hwnd = GetForegroundWindow();
      int pid = 0;
      string exe = null;
      string path = null;
      string title = null;
      string packageFamily = null;
      bool hasWindow = false;
      int left = 0;
      int top = 0;
      int width = 0;
      int height = 0;

      if (hwnd != IntPtr.Zero) {
        uint targetPid = 0;
        GetWindowThreadProcessId(hwnd, out targetPid);
        if (targetPid > 0 && targetPid <= Int32.MaxValue) {
          pid = (int)targetPid;
          try {
            using (Process process = Process.GetProcessById(pid)) {
              exe = process.ProcessName.ToLowerInvariant() + ".exe";
              try { path = process.MainModule.FileName; } catch { path = null; }
            }
          } catch {
            exe = null;
          }

          if (exe == null) {
            pid = 0;
          } else {
            title = WindowTitle(hwnd);
            packageFamily = FamilyName(pid);
            if (Usable(hwnd)) {
              RECT rect = Bounds(hwnd);
              long windowWidth = (long)rect.Right - rect.Left;
              long windowHeight = (long)rect.Bottom - rect.Top;
              if (windowWidth > 0 && windowWidth <= Int32.MaxValue && windowHeight > 0 && windowHeight <= Int32.MaxValue) {
                hasWindow = true;
                left = rect.Left;
                top = rect.Top;
                width = (int)windowWidth;
                height = (int)windowHeight;
              }
            }
          }
        }
      }

      bool changed = !lastEmitted
        || pid != lastPid
        || !String.Equals(exe, lastExe, StringComparison.Ordinal)
        || !String.Equals(path, lastPath, StringComparison.Ordinal)
        || !String.Equals(title, lastTitle, StringComparison.Ordinal)
        || !String.Equals(packageFamily, lastPackage, StringComparison.Ordinal)
        || hasWindow != lastHasWindow
        || left != lastLeft
        || top != lastTop
        || width != lastWidth
        || height != lastHeight;
      if (!changed) return;

      lastEmitted = true;
      lastPid = pid;
      lastExe = exe;
      lastPath = path;
      lastTitle = title;
      lastPackage = packageFamily;
      lastHasWindow = hasWindow;
      lastLeft = left;
      lastTop = top;
      lastWidth = width;
      lastHeight = height;

      StringBuilder json = new StringBuilder(256);
      json.Append("{\"foreground\":");
      if (pid > 0 && exe != null) {
        json.Append("{\"pid\":").Append(pid).Append(",\"exe\":");
        AppendString(json, exe);
        json.Append(",\"path\":");
        AppendString(json, path);
        json.Append(",\"title\":");
        AppendString(json, title);
        json.Append(",\"packageFamilyName\":");
        AppendString(json, packageFamily);
        json.Append('}');
      } else {
        json.Append("null");
      }

      json.Append(",\"window\":");
      if (hasWindow) {
        json.Append("{\"left\":").Append(left)
          .Append(",\"top\":").Append(top)
          .Append(",\"width\":").Append(width)
          .Append(",\"height\":").Append(height)
          .Append('}');
      } else {
        json.Append("null");
      }
      json.Append('}');

      Console.Out.WriteLine(json.ToString());
      Console.Out.Flush();
    }
  }

  static string WindowTitle(IntPtr hwnd) {
    int length = GetWindowTextLength(hwnd);
    if (length <= 0) return null;
    if (length > 1024) length = 1024;
    StringBuilder text = new StringBuilder(length + 1);
    GetWindowText(hwnd, text, text.Capacity);
    return text.ToString();
  }

  static bool Usable(IntPtr hwnd) {
    return hwnd != IntPtr.Zero && IsWindowVisible(hwnd) && !IsIconic(hwnd);
  }

  static RECT Bounds(IntPtr hwnd) {
    RECT rect = new RECT();
    try { GetWindowRect(hwnd, out rect); } catch { }
    return rect;
  }

  /// Reads the AppContainer package identity for a pid. Returns null for unpackaged
  /// (Win32 / Steam / Epic) processes, which is the common case.
  static string FamilyName(int pid) {
    IntPtr handle = OpenProcess(QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      uint length = 256;
      StringBuilder buffer = new StringBuilder(256);
      int result = GetPackageFamilyName(handle, ref length, buffer);
      return result == 0 ? buffer.ToString() : null;
    } catch { return null; } finally { CloseHandle(handle); }
  }

  static void AppendString(StringBuilder json, string value) {
    if (value == null) { json.Append("null"); return; }
    json.Append('"');
    for (int index = 0; index < value.Length; index += 1) {
      char character = value[index];
      switch (character) {
        case '"': json.Append("\\\""); break;
        case '\\': json.Append("\\\\"); break;
        case '\b': json.Append("\\b"); break;
        case '\f': json.Append("\\f"); break;
        case '\n': json.Append("\\n"); break;
        case '\r': json.Append("\\r"); break;
        case '\t': json.Append("\\t"); break;
        default:
          if (character < ' ') json.Append("\\u").Append(((int)character).ToString("x4"));
          else json.Append(character);
          break;
      }
    }
    json.Append('"');
  }
}
"@ | Out-Null

[TsForeground]::Run()
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
