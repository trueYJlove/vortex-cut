param([int]$TargetHz)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DisplaySwitch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion; public ushort dmDriverVersion; public ushort dmSize; public ushort dmDriverExtra;
    public uint dmFields;
    public int dmPositionX; public int dmPositionY; public uint dmDisplayOrientation; public uint dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels; public uint dmBitsPerPel; public uint dmPelsWidth; public uint dmPelsHeight;
    public uint dmDisplayFlags; public uint dmDisplayFrequency;
    public uint dmICMMethod; public uint dmICMIntent; public uint dmMediaType; public uint dmDitherType;
    public uint dmReserved1; public uint dmReserved2; public uint dmPanningWidth; public uint dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  public static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr hwnd, uint flags, IntPtr lParam);
  public static object Current() {
    DEVMODE dm = new DEVMODE();
    dm.dmDeviceName = new string(new char[32]);
    dm.dmFormName = new string(new char[32]);
    dm.dmSize = (ushort)Marshal.SizeOf(dm);
    if (!EnumDisplaySettings(null, -1, ref dm)) return null;
    return new object[] { dm.dmPelsWidth, dm.dmPelsHeight, (int)dm.dmDisplayFrequency };
  }
  public static int SetFrequency(int hz) {
    DEVMODE dm = new DEVMODE();
    dm.dmDeviceName = new string(new char[32]);
    dm.dmFormName = new string(new char[32]);
    dm.dmSize = (ushort)Marshal.SizeOf(dm);
    if (!EnumDisplaySettings(null, -1, ref dm)) return -1;
    dm.dmFields = 0x00400000; // DM_DISPLAYFREQUENCY
    dm.dmDisplayFrequency = (uint)hz;
    return ChangeDisplaySettingsEx(null, ref dm, IntPtr.Zero, 0, IntPtr.Zero);
  }
}
"@
if ($TargetHz -gt 0) {
  $result = [DisplaySwitch]::SetFrequency($TargetHz)
  Write-Output ("set({0}) -> {1}" -f $TargetHz, $result)
} 
$cur = [DisplaySwitch]::Current()
Write-Output ("current: {0}x{1} @ {2}Hz" -f $cur[0], $cur[1], $cur[2])
