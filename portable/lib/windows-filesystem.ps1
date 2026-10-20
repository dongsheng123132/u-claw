param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
# Query this path's volume directly. Get-Volume can enumerate slow/offline USBs.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UClawVolume {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumePathName(string path, StringBuilder root, int length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumeInformation(string root, StringBuilder label, int labelLength, out uint serial, out uint maxName, out uint flags, StringBuilder fs, int fsLength);
}
'@
$root=[Text.StringBuilder]::new(1024)
if (-not [UClawVolume]::GetVolumePathName([IO.Path]::GetFullPath($Path),$root,$root.Capacity)) { throw 'Cannot resolve the portable volume' }
$fs=[Text.StringBuilder]::new(64)
$label=[Text.StringBuilder]::new(256)
[uint32]$serial=0; [uint32]$maxName=0; [uint32]$flags=0
if (-not [UClawVolume]::GetVolumeInformation($root.ToString(),$label,$label.Capacity,[ref]$serial,[ref]$maxName,[ref]$flags,$fs,$fs.Capacity)) { throw 'Cannot read the portable filesystem' }
$fs.ToString()
