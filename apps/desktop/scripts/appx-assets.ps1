# Makes the Microsoft Store (MSIX) logos and tiles in build/appx/ from build/icon.png.
# electron-builder's appx target picks them up by name. Run again if the icon changes:
#   powershell -NoProfile -File apps/desktop/scripts/appx-assets.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'build\icon.png'))
$out = Join-Path $root 'build\appx'
New-Item -ItemType Directory -Force $out | Out-Null

# The icon's own dark background, so tiles read as one piece. Matches appx.backgroundColor.
$background = [System.Drawing.ColorTranslator]::FromHtml('#161525')

function Save-Logo([string]$name, [int]$width, [int]$height, [double]$iconShare, [bool]$fill) {
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  if ($fill) { $g.Clear($background) } else { $g.Clear([System.Drawing.Color]::Transparent) }
  $size = [int][Math]::Round([Math]::Min($width, $height) * $iconShare)
  $x = [int](($width - $size) / 2)
  $y = [int](($height - $size) / 2)
  $g.DrawImage($source, $x, $y, $size, $size)
  $g.Dispose()
  $bitmap.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

# Icons: the whole rounded-square icon, edge to edge.
Save-Logo 'StoreLogo.png' 50 50 1 $false
Save-Logo 'Square44x44Logo.png' 44 44 1 $false
foreach ($size in 16, 24, 32, 48, 256) {
  Save-Logo "Square44x44Logo.targetsize-$size.png" $size $size 1 $false
  # Unplated: the taskbar and Start show these as they are, with no coloured plate behind.
  Save-Logo "Square44x44Logo.targetsize-${size}_altform-unplated.png" $size $size 1 $false
}

# Tiles: the icon centred on its own background colour.
Save-Logo 'SmallTile.png' 71 71 0.8 $true
Save-Logo 'Square150x150Logo.png' 150 150 0.7 $true
Save-Logo 'LargeTile.png' 310 310 0.6 $true
Save-Logo 'Wide310x150Logo.png' 310 150 0.75 $true

$source.Dispose()
Write-Output "appx assets -> $out"
