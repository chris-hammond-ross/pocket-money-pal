# Makes the Android launcher icons in android/app/src/main/res/mipmap-*/ from the desktop
# app's icon (apps/desktop/build/icon.png), like appx-assets.ps1 does for the Store. Run again if
# the icon changes:
#   powershell -NoProfile -File apps/mobile/scripts/android-icons.ps1
#
# ic_launcher.png         the whole rounded-square icon (Android 7.1 and older)
# ic_launcher_foreground  the adaptive icon's foreground (Android 8+): the icon enlarged on the
#                         108dp layer, so its dark square fills the launcher's mask (a 66-72dp
#                         circle or squircle) and the pig sits in the middle. The background layer
#                         is the icon's own dark colour, #161525 as on the Store tiles
#                         (values/colors.xml).
Add-Type -AssemblyName System.Drawing

$mobile = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $mobile)
$source = [System.Drawing.Image]::FromFile((Join-Path $repo 'apps\desktop\build\icon.png'))
$res = Join-Path $mobile 'android\app\src\main\res'

function Save-Icon([string]$path, [int]$canvas, [double]$iconShare) {
  $bitmap = New-Object System.Drawing.Bitmap $canvas, $canvas
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $size = [int][Math]::Round($canvas * $iconShare)
  $offset = [int](($canvas - $size) / 2)
  $g.DrawImage($source, $offset, $offset, $size, $size)
  $g.Dispose()
  New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

# density → scale from mdpi (48dp legacy icon, 108dp adaptive layer)
$densities = @{ 'mdpi' = 1.0; 'hdpi' = 1.5; 'xhdpi' = 2.0; 'xxhdpi' = 3.0; 'xxxhdpi' = 4.0 }
foreach ($d in $densities.Keys) {
  $scale = $densities[$d]
  Save-Icon (Join-Path $res "mipmap-$d\ic_launcher.png") ([int](48 * $scale)) 1.0
  Save-Icon (Join-Path $res "mipmap-$d\ic_launcher_foreground.png") ([int](108 * $scale)) 0.8
}
$source.Dispose()
Write-Output "icons -> $res"
