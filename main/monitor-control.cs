// DisplayCore 輸出螢幕控制：由 Windows PowerShell 5.1 以 Add-Type 編譯（C# 5）。
//
// 以 GDI 顯示裝置的桌面原點（實體像素）辨識螢幕，查詢並切換顯示模式；
// 亮度／對比經 DDC/CI 的 VCP 0x10／0x12 讀寫。所有輸出皆為固定格式 JSON。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DisplayCoreMonitorControl
{
    const int ENUM_CURRENT_SETTINGS = -1;
    const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
    const int DM_BITSPERPEL = 0x40000;
    const int DM_PELSWIDTH = 0x80000;
    const int DM_PELSHEIGHT = 0x100000;
    const int DM_DISPLAYFREQUENCY = 0x400000;
    const int CDS_UPDATEREGISTRY = 0x1;
    const int CDS_TEST = 0x2;
    const int DISP_CHANGE_SUCCESSFUL = 0;
    const byte VCP_BRIGHTNESS = 0x10;
    const byte VCP_CONTRAST = 0x12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PHYSICAL_MONITOR
    {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription;
    }

    delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplayDevices(string device, int index, ref DISPLAY_DEVICE info, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE devMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE devMode, IntPtr hwnd, int flags, IntPtr param);

    [DllImport("user32.dll")]
    static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr monitor, byte code, IntPtr type, out uint current, out uint maximum);

    [DllImport("dxva2.dll", SetLastError = true)]
    static extern bool SetVCPFeature(IntPtr monitor, byte code, uint value);

    static DEVMODE NewDevMode()
    {
        DEVMODE mode = new DEVMODE();
        mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        return mode;
    }

    /// <summary>以桌面原點（實體像素）找出附加到桌面的 GDI 顯示裝置名稱。</summary>
    static string FindDevice(int x, int y)
    {
        for (int index = 0; ; index++)
        {
            DISPLAY_DEVICE device = new DISPLAY_DEVICE();
            device.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            if (!EnumDisplayDevices(null, index, ref device, 0))
            {
                return null;
            }

            if ((device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) == 0)
            {
                continue;
            }

            DEVMODE current = NewDevMode();
            if (
                EnumDisplaySettings(device.DeviceName, ENUM_CURRENT_SETTINGS, ref current) &&
                current.dmPositionX == x &&
                current.dmPositionY == y
            )
            {
                return device.DeviceName;
            }
        }
    }

    static IntPtr FindMonitorHandle(string deviceName)
    {
        IntPtr found = IntPtr.Zero;
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(monitor, ref info) && info.szDevice == deviceName)
            {
                found = monitor;
                return false;
            }

            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>取得第一個實體螢幕的 DDC/CI handle；呼叫端必須 DestroyPhysicalMonitors。</summary>
    static PHYSICAL_MONITOR[] OpenPhysicalMonitors(string deviceName)
    {
        IntPtr monitor = FindMonitorHandle(deviceName);
        uint count;
        if (
            monitor == IntPtr.Zero ||
            !GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, out count) ||
            count == 0
        )
        {
            return null;
        }

        PHYSICAL_MONITOR[] monitors = new PHYSICAL_MONITOR[count];
        return GetPhysicalMonitorsFromHMONITOR(monitor, count, monitors) ? monitors : null;
    }

    static string ReadVcp(PHYSICAL_MONITOR[] monitors, byte code)
    {
        uint current;
        uint maximum;
        if (
            monitors == null ||
            !GetVCPFeatureAndVCPFeatureReply(monitors[0].hPhysicalMonitor, code, IntPtr.Zero, out current, out maximum) ||
            maximum == 0 ||
            current > maximum
        )
        {
            return "{\"supported\":false}";
        }

        int percent = (int)Math.Round(current * 100.0 / maximum);
        return "{\"supported\":true,\"percent\":" + percent + "}";
    }

    static string WriteVcp(PHYSICAL_MONITOR[] monitors, byte code, int percent)
    {
        if (percent < 0)
        {
            return "\"unchanged\"";
        }

        uint current;
        uint maximum;
        if (
            monitors == null ||
            !GetVCPFeatureAndVCPFeatureReply(monitors[0].hPhysicalMonitor, code, IntPtr.Zero, out current, out maximum) ||
            maximum == 0
        )
        {
            return "\"unsupported\"";
        }

        uint target = (uint)Math.Round(percent * maximum / 100.0);
        if (target == current)
        {
            return "\"unchanged\"";
        }

        return SetVCPFeature(monitors[0].hPhysicalMonitor, code, target) ? "\"applied\"" : "\"failed\"";
    }

    /// <summary>列出與目前色深、方向相同的顯示模式，每個寬高只保留一筆。</summary>
    static List<int[]> ListModes(string deviceName, DEVMODE current)
    {
        List<int[]> modes = new List<int[]>();
        HashSet<long> seen = new HashSet<long>();
        for (int index = 0; ; index++)
        {
            DEVMODE mode = NewDevMode();
            if (!EnumDisplaySettings(deviceName, index, ref mode))
            {
                return modes;
            }

            if (
                mode.dmBitsPerPel != current.dmBitsPerPel ||
                mode.dmDisplayOrientation != current.dmDisplayOrientation
            )
            {
                continue;
            }

            long key = ((long)mode.dmPelsWidth << 32) | (uint)mode.dmPelsHeight;
            if (seen.Add(key))
            {
                modes.Add(new int[] { mode.dmPelsWidth, mode.dmPelsHeight });
            }
        }
    }

    /// <summary>找出指定寬高的模式；優先沿用目前更新率，否則取最高更新率。</summary>
    static bool FindMode(string deviceName, DEVMODE current, int width, int height, out DEVMODE best)
    {
        best = NewDevMode();
        bool found = false;
        for (int index = 0; ; index++)
        {
            DEVMODE mode = NewDevMode();
            if (!EnumDisplaySettings(deviceName, index, ref mode))
            {
                return found;
            }

            if (
                mode.dmPelsWidth != width ||
                mode.dmPelsHeight != height ||
                mode.dmBitsPerPel != current.dmBitsPerPel ||
                mode.dmDisplayOrientation != current.dmDisplayOrientation
            )
            {
                continue;
            }

            bool better =
                !found ||
                (mode.dmDisplayFrequency == current.dmDisplayFrequency &&
                    best.dmDisplayFrequency != current.dmDisplayFrequency) ||
                (best.dmDisplayFrequency != current.dmDisplayFrequency &&
                    mode.dmDisplayFrequency > best.dmDisplayFrequency);
            if (better)
            {
                best = mode;
                found = true;
            }
        }
    }

    static string ApplyResolution(string deviceName, DEVMODE current, int width, int height)
    {
        if (width <= 0)
        {
            return "\"unchanged\"";
        }

        if (current.dmPelsWidth == width && current.dmPelsHeight == height)
        {
            return "\"unchanged\"";
        }

        DEVMODE mode;
        if (!FindMode(deviceName, current, width, height, out mode))
        {
            return "\"unsupported\"";
        }

        mode.dmFields = DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        if (ChangeDisplaySettingsEx(deviceName, ref mode, IntPtr.Zero, CDS_TEST, IntPtr.Zero) != DISP_CHANGE_SUCCESSFUL)
        {
            return "\"failed\"";
        }

        return ChangeDisplaySettingsEx(deviceName, ref mode, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero) == DISP_CHANGE_SUCCESSFUL
            ? "\"applied\""
            : "\"failed\"";
    }

    public static string Query(int x, int y)
    {
        string deviceName = FindDevice(x, y);
        DEVMODE current = NewDevMode();
        if (deviceName == null || !EnumDisplaySettings(deviceName, ENUM_CURRENT_SETTINGS, ref current))
        {
            return "{\"found\":false}";
        }

        StringBuilder json = new StringBuilder();
        json.Append("{\"found\":true,\"current\":[");
        json.Append(current.dmPelsWidth).Append(',').Append(current.dmPelsHeight);
        json.Append("],\"modes\":[");
        List<int[]> modes = ListModes(deviceName, current);
        for (int index = 0; index < modes.Count; index++)
        {
            if (index > 0)
            {
                json.Append(',');
            }

            json.Append('[').Append(modes[index][0]).Append(',').Append(modes[index][1]).Append(']');
        }

        PHYSICAL_MONITOR[] monitors = OpenPhysicalMonitors(deviceName);
        try
        {
            json.Append("],\"brightness\":").Append(ReadVcp(monitors, VCP_BRIGHTNESS));
            json.Append(",\"contrast\":").Append(ReadVcp(monitors, VCP_CONTRAST));
        }
        finally
        {
            if (monitors != null)
            {
                DestroyPhysicalMonitors((uint)monitors.Length, monitors);
            }
        }

        return json.Append('}').ToString();
    }

    /// <summary>寬度 0 表示不切換解析度；百分比 -1 表示不調整該項。</summary>
    public static string Apply(int x, int y, int width, int height, int brightness, int contrast)
    {
        string deviceName = FindDevice(x, y);
        DEVMODE current = NewDevMode();
        if (deviceName == null || !EnumDisplaySettings(deviceName, ENUM_CURRENT_SETTINGS, ref current))
        {
            return "{\"found\":false}";
        }

        string resolution = ApplyResolution(deviceName, current, width, height);
        // 解析度切換後 HMONITOR 可能重建，DDC/CI 一律重新取得 handle。
        PHYSICAL_MONITOR[] monitors = OpenPhysicalMonitors(deviceName);
        try
        {
            return "{\"found\":true,\"resolution\":" + resolution +
                ",\"brightness\":" + WriteVcp(monitors, VCP_BRIGHTNESS, brightness) +
                ",\"contrast\":" + WriteVcp(monitors, VCP_CONTRAST, contrast) + "}";
        }
        finally
        {
            if (monitors != null)
            {
                DestroyPhysicalMonitors((uint)monitors.Length, monitors);
            }
        }
    }
}
