/**
 * ETW present tracing for the performance OSD.
 *
 * This is deliberately not a graphics hook: it opens a real-time ETW session and
 * subscribes to Microsoft-Windows-DXGI `Present` (event 42) and Microsoft-Windows-D3D9
 * `Present` (event 1), then counts events whose ETW header carries the game's pid. No
 * code, DLL or hook enters the game process.
 *
 * ETW sessions need administrator rights or membership of the built-in
 * `Performance Log Users` group. When neither is available the helper reports
 * `unavailable`; the OSD still shows the active profile and temperatures.
 *
 * The C# body is static, code-owned text. Only validated integers are substituted into
 * the wrapper.
 */
import { TuneSmithError } from '../../../shared/errors';

const FRAME_MONITOR_BODY = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TsFps
{
    private const string SessionName = "TuneSmithFps";
    private const uint EventTraceRealTimeMode = 0x00000100;
    private const uint WnodeFlagTracedGuid = 0x00020000;
    private const uint ProcessTraceModeEventRecord = 0x10000000;
    private const uint ProcessTraceModeRealTime = 0x00000100;
    private const uint EventTraceControlStop = 1;
    private const uint EventControlEnableProvider = 1;
    private const ulong InvalidHandle = ulong.MaxValue;
    private const int DxgiPresent = 42;
    private const int D3d9Present = 1;

    private static readonly Guid DxgiProvider = new Guid("ca11c036-0102-4a2d-a6ad-f03cfed5d3c9");
    private static readonly Guid D3d9Provider = new Guid("783aca0a-790e-4d7f-8451-aa850511c6b9");

    private static readonly object Gate = new object();
    private static readonly Queue<long> Timestamps = new Queue<long>();
    private static long lastEventUtcTicks;
    private static int targetPid;
    private static int parentPid;
    private static int intervalMs = 1000;
    private static ulong sessionHandle;
    private static ulong traceHandle;
    private static bool running;
    private static EventRecordCallback callback;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void EventRecordCallback(IntPtr record);

    [StructLayout(LayoutKind.Sequential)]
    private struct WNODE_HEADER
    {
        public uint BufferSize;
        public uint ProviderId;
        public ulong HistoricalContext;
        public ulong TimeStamp;
        public Guid Guid;
        public uint ClientContext;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_TRACE_PROPERTIES
    {
        public WNODE_HEADER Wnode;
        public uint BufferSize;
        public uint MinimumBuffers;
        public uint MaximumBuffers;
        public uint MaximumFileSize;
        public uint LogFileMode;
        public uint FlushTimer;
        public uint EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers;
        public uint FreeBuffers;
        public uint EventsLost;
        public uint BuffersWritten;
        public uint LogBuffersLost;
        public uint RealTimeBuffersLost;
        public IntPtr LoggerThreadId;
        public uint LogFileNameOffset;
        public uint LoggerNameOffset;
    }

    [StructLayout(LayoutKind.Sequential, Size = 0xac, CharSet = CharSet.Unicode)]
    private struct TIME_ZONE_INFORMATION
    {
        public uint Bias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string StandardName;
        [MarshalAs(UnmanagedType.ByValArray, ArraySubType = UnmanagedType.U2, SizeConst = 8)] public ushort[] StandardDate;
        public uint StandardBias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DaylightName;
        [MarshalAs(UnmanagedType.ByValArray, ArraySubType = UnmanagedType.U2, SizeConst = 8)] public ushort[] DaylightDate;
        public uint DaylightBias;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_TRACE_HEADER
    {
        public ushort Size;
        public ushort FieldTypeFlags;
        public byte Type;
        public byte Level;
        public ushort Version;
        public int ThreadId;
        public int ProcessId;
        public long TimeStamp;
        public Guid Guid;
        public uint KernelTime;
        public uint UserTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ETW_BUFFER_CONTEXT
    {
        public byte ProcessorNumber;
        public byte Alignment;
        public ushort LoggerId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_TRACE
    {
        public EVENT_TRACE_HEADER Header;
        public uint InstanceId;
        public uint ParentInstanceId;
        public Guid ParentGuid;
        public IntPtr MofData;
        public int MofLength;
        public ETW_BUFFER_CONTEXT BufferContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TRACE_LOGFILE_HEADER
    {
        public uint BufferSize;
        public uint Version;
        public uint ProviderVersion;
        public uint NumberOfProcessors;
        public long EndTime;
        public uint TimerResolution;
        public uint MaximumFileSize;
        public uint LogFileMode;
        public uint BuffersWritten;
        public uint StartBuffers;
        public uint PointerSize;
        public uint EventsLost;
        public uint CpuSpeedInMHz;
        public IntPtr LoggerName;
        public IntPtr LogFileName;
        public TIME_ZONE_INFORMATION TimeZone;
        public long BootTime;
        public long PerfFreq;
        public long StartTime;
        public uint ReservedFlags;
        public uint BuffersLost;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct EVENT_TRACE_LOGFILE
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string LogFileName;
        [MarshalAs(UnmanagedType.LPWStr)] public string LoggerName;
        public long CurrentTime;
        public uint BuffersRead;
        public uint LogFileMode;
        public EVENT_TRACE CurrentEvent;
        public TRACE_LOGFILE_HEADER LogfileHeader;
        public IntPtr BufferCallback;
        public int BufferSize;
        public int Filled;
        public int EventsLost;
        public IntPtr EventRecordCallback;
        public int IsKernelTrace;
        public IntPtr Context;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_HEADER
    {
        public ushort Size;
        public ushort HeaderType;
        public ushort Flags;
        public ushort EventProperty;
        public int ThreadId;
        public int ProcessId;
        public long TimeStamp;
        public Guid ProviderId;
        public ushort Id;
        public byte Version;
        public byte Channel;
        public byte Level;
        public byte Opcode;
        public ushort Task;
        public ulong Keyword;
        public uint KernelTime;
        public uint UserTime;
        public Guid ActivityId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EVENT_RECORD
    {
        public EVENT_HEADER EventHeader;
        public ETW_BUFFER_CONTEXT BufferContext;
        public ushort ExtendedDataCount;
        public ushort UserDataLength;
        public IntPtr ExtendedData;
        public IntPtr UserData;
        public IntPtr UserContext;
    }

    [DllImport("advapi32.dll", EntryPoint = "StartTraceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int StartTraceW(out ulong sessionHandle, string sessionName, IntPtr properties);

    [DllImport("advapi32.dll", EntryPoint = "ControlTraceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int ControlTraceW(ulong sessionHandle, string sessionName, IntPtr properties, uint controlCode);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int EnableTraceEx2(
        ulong traceHandle,
        ref Guid providerId,
        uint controlCode,
        byte level,
        ulong matchAnyKeyword,
        ulong matchAllKeyword,
        uint timeout,
        IntPtr enableParameters);

    [DllImport("advapi32.dll", EntryPoint = "OpenTraceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ulong OpenTraceW(ref EVENT_TRACE_LOGFILE logfile);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int ProcessTrace(ulong[] handleArray, uint handleCount, IntPtr startTime, IntPtr endTime);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int CloseTrace(ulong traceHandle);

    public static int Run(int gamePid, int sampleMs, int parentProcessId)
    {
        targetPid = gamePid;
        parentPid = parentProcessId;
        intervalMs = Math.Max(500, Math.Min(5000, sampleMs));

        if (targetPid <= 0)
        {
            PrintStatus("unavailable", "Invalid game process id.");
            return 2;
        }

        int result = Start();
        if (result != 0) return result;

        PrintStatus("running", "ETW present tracing active.");
        while (running)
        {
            Thread.Sleep(intervalMs);
            if (!running) break;
            if (!ParentAlive())
            {
                PrintStatus("unavailable", "The TuneSmith process exited; ETW tracing stopped.");
                break;
            }
            Report();
        }

        Stop();
        return 0;
    }

    private static bool ParentAlive()
    {
        try
        {
            using (Process parent = Process.GetProcessById(parentPid))
            {
                return !parent.HasExited;
            }
        }
        catch
        {
            return false;
        }
    }

    private static IntPtr AllocateProperties()
    {
        int size = Marshal.SizeOf(typeof(EVENT_TRACE_PROPERTIES)) + (SessionName.Length + 1) * 2;
        IntPtr pointer = Marshal.AllocHGlobal(size);
        byte[] zero = new byte[size];
        Marshal.Copy(zero, 0, pointer, size);

        EVENT_TRACE_PROPERTIES properties = new EVENT_TRACE_PROPERTIES();
        properties.Wnode.BufferSize = (uint)size;
        properties.Wnode.Flags = WnodeFlagTracedGuid;
        properties.LogFileMode = EventTraceRealTimeMode;
        properties.FlushTimer = 1;
        properties.LoggerNameOffset = (uint)Marshal.SizeOf(typeof(EVENT_TRACE_PROPERTIES));
        Marshal.StructureToPtr(properties, pointer, false);

        char[] name = (SessionName + "\0").ToCharArray();
        Marshal.Copy(name, 0, new IntPtr(pointer.ToInt64() + properties.LoggerNameOffset), name.Length);
        return pointer;
    }

    private static int Start()
    {
        IntPtr properties = AllocateProperties();
        try
        {
            // Clear a session a previous crash may have left behind. The name is unique
            // to this app and the app is single-instance, so this cannot stop another app.
            ControlTraceW(0, SessionName, properties, EventTraceControlStop);

            int result = StartTraceW(out sessionHandle, SessionName, properties);
            if (result == 183)
            {
                ControlTraceW(0, SessionName, properties, EventTraceControlStop);
                result = StartTraceW(out sessionHandle, SessionName, properties);
            }
            if (result != 0)
            {
                PrintStatus("unavailable", "ETW session could not start (error " + result + "). Run TuneSmith elevated or add this account to Performance Log Users.");
                return 2;
            }

            // A static readonly Guid cannot be passed by ref; the P/Invoke needs a local.
            Guid dxgiProvider = DxgiProvider;
            Guid d3d9Provider = D3d9Provider;
            int dxgi = EnableTraceEx2(sessionHandle, ref dxgiProvider, EventControlEnableProvider, 5, ulong.MaxValue, 0, 0, IntPtr.Zero);
            int d3d9 = EnableTraceEx2(sessionHandle, ref d3d9Provider, EventControlEnableProvider, 5, ulong.MaxValue, 0, 0, IntPtr.Zero);
            if (dxgi != 0 && d3d9 != 0)
            {
                PrintStatus("unavailable", "ETW present providers could not be enabled (error " + dxgi + ").");
                Stop();
                return 2;
            }

            callback = OnEvent;
            EVENT_TRACE_LOGFILE logfile = new EVENT_TRACE_LOGFILE();
            logfile.LoggerName = SessionName;
            logfile.LogFileMode = ProcessTraceModeEventRecord | ProcessTraceModeRealTime;
            logfile.EventRecordCallback = Marshal.GetFunctionPointerForDelegate(callback);

            traceHandle = OpenTraceW(ref logfile);
            if (traceHandle == InvalidHandle)
            {
                int code = Marshal.GetLastWin32Error();
                PrintStatus("unavailable", "ETW consumer could not open the trace session (error " + code + ").");
                Stop();
                return 2;
            }

            running = true;
            Thread pump = new Thread(Pump);
            pump.IsBackground = true;
            pump.Name = "TuneSmithFpsEtw";
            pump.Start();
            return 0;
        }
        catch (Exception error)
        {
            PrintStatus("unavailable", "ETW setup failed: " + error.Message);
            Stop();
            return 2;
        }
        finally
        {
            Marshal.FreeHGlobal(properties);
        }
    }

    private static void Pump()
    {
        try
        {
            int result = ProcessTrace(new ulong[] { traceHandle }, 1, IntPtr.Zero, IntPtr.Zero);
            if (running)
            {
                running = false;
                PrintStatus("unavailable", "ETW trace processing ended (error " + result + ").");
            }
        }
        catch (Exception error)
        {
            if (running)
            {
                running = false;
                PrintStatus("unavailable", "ETW trace processing failed: " + error.Message);
            }
        }
    }

    private static void Stop()
    {
        running = false;
        if (traceHandle != 0 && traceHandle != InvalidHandle)
        {
            try { CloseTrace(traceHandle); } catch { }
            traceHandle = 0;
        }

        if (sessionHandle != 0)
        {
            IntPtr properties = AllocateProperties();
            try { ControlTraceW(0, SessionName, properties, EventTraceControlStop); }
            catch { }
            finally { Marshal.FreeHGlobal(properties); }
            sessionHandle = 0;
        }
    }

    private static void OnEvent(IntPtr recordPointer)
    {
        try
        {
            EVENT_RECORD record = (EVENT_RECORD)Marshal.PtrToStructure(recordPointer, typeof(EVENT_RECORD));
            if (record.EventHeader.ProcessId != targetPid) return;

            bool dxgi = record.EventHeader.ProviderId == DxgiProvider && record.EventHeader.Id == DxgiPresent;
            bool d3d9 = record.EventHeader.ProviderId == D3d9Provider && record.EventHeader.Id == D3d9Present;
            if (!dxgi && !d3d9) return;
            if (record.EventHeader.TimeStamp <= 0) return;

            lock (Gate)
            {
                Timestamps.Enqueue(record.EventHeader.TimeStamp);
                while (Timestamps.Count > 20000) Timestamps.Dequeue();
                lastEventUtcTicks = DateTime.UtcNow.Ticks;
            }
        }
        catch
        {
            // A single malformed ETW record must never take down the sampler.
        }
    }

    private static void Report()
    {
        long[] values;
        lock (Gate)
        {
            if (Timestamps.Count == 0 || DateTime.UtcNow.Ticks - lastEventUtcTicks > 2 * TimeSpan.TicksPerSecond)
            {
                Timestamps.Clear();
            }
            values = Timestamps.ToArray();
        }

        double? fps = null;
        double? low1 = null;
        double? frameTime = null;
        int frames = 0;

        if (values.Length >= 2)
        {
            long last = values[values.Length - 1];
            long oneSecond = last - TimeSpan.TicksPerSecond;
            long tenSeconds = last - 10 * TimeSpan.TicksPerSecond;
            List<double> recent = new List<double>();
            List<double> window = new List<double>();

            for (int index = 1; index < values.Length; index++)
            {
                long end = values[index];
                if (end < tenSeconds) continue;
                double ms = (end - values[index - 1]) / (double)TimeSpan.TicksPerMillisecond;
                if (ms <= 0 || ms > 5000) continue;
                window.Add(ms);
                if (end >= oneSecond) recent.Add(ms);
            }

            if (recent.Count > 0)
            {
                double totalMs = 0;
                foreach (double ms in recent) totalMs += ms;
                fps = recent.Count / (totalMs / 1000.0);
                frameTime = totalMs / recent.Count;
                frames = recent.Count;
            }

            if (window.Count > 1)
            {
                window.Sort();
                int worstCount = Math.Max(1, (int)Math.Ceiling(window.Count * 0.01));
                double worstMs = 0;
                for (int index = window.Count - worstCount; index < window.Count; index++) worstMs += window[index];
                double averageWorst = worstMs / worstCount;
                if (averageWorst > 0) low1 = 1000.0 / averageWorst;
            }
        }

        if (fps.HasValue && (!IsFinite(fps.Value) || fps.Value <= 0)) fps = null;
        if (low1.HasValue && (!IsFinite(low1.Value) || low1.Value <= 0)) low1 = null;
        if (frameTime.HasValue && (!IsFinite(frameTime.Value) || frameTime.Value <= 0)) frameTime = null;

        Console.WriteLine("{\"type\":\"sample\",\"fps\":" + Number(fps) + ",\"low1Fps\":" + Number(low1) +
            ",\"frameTimeMs\":" + Number(frameTime) + ",\"frames\":" + frames.ToString(CultureInfo.InvariantCulture) +
            ",\"at\":\"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\"}");
        Console.Out.Flush();
    }

    private static bool IsFinite(double value)
    {
        return !double.IsNaN(value) && !double.IsInfinity(value);
    }

    private static string Number(double? value)
    {
        return value.HasValue ? value.Value.ToString("0.0", CultureInfo.InvariantCulture) : "null";
    }

    private static void PrintStatus(string state, string message)
    {
        Console.WriteLine("{\"type\":\"status\",\"state\":\"" + state + "\",\"message\":\"" + Escape(message) + "\"}");
        Console.Out.Flush();
    }

    private static string Escape(string value)
    {
        return (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }
}
'@

exit [TsFps]::Run(TARGET_PID, INTERVAL_MS, PARENT_PID)
`;

/** Clamp matches the renderer's patience without letting a caller spin ETW. */
export function clampFrameSampleMs(value: number): number {
  if (!Number.isFinite(value)) return 1_000;
  return Math.min(5_000, Math.max(500, Math.round(value)));
}

export function buildFrameMonitorScript(pid: number, intervalMs = 1_000, parentPid = process.pid): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TuneSmithError('invalid-request', 'Frame monitor needs a positive process id.');
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new TuneSmithError('invalid-request', 'Frame monitor needs a positive parent process id.');
  }

  return FRAME_MONITOR_BODY.replace('TARGET_PID', String(pid))
    .replace('PARENT_PID', String(parentPid))
    .replace('INTERVAL_MS', String(clampFrameSampleMs(intervalMs)));
}
