param(
  [Parameter(Mandatory=$true)][string]$AnsiPath,
  [Parameter(Mandatory=$true)][string]$PngPath,
  [Parameter(Mandatory=$true)][int]$Columns,
  [Parameter(Mandatory=$true)][int]$Rows
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# This is a replay of the visible ANSI, not a screenshot of the Herdr window.
$fontName = 'Consolas'
$fontSize = 14
$cellWidth = 9
$cellHeight = 20
$font = New-Object System.Drawing.Font($fontName, $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$boldFont = New-Object System.Drawing.Font($fontName, $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
if ($font.FontFamily.Name -ne $fontName) { throw "Requested font not available: $fontName" }
$bitmap = New-Object System.Drawing.Bitmap(($Columns * $cellWidth), ($Rows * $cellHeight))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::FromArgb(18, 18, 18))
$format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces -bor [System.Drawing.StringFormatFlags]::NoWrap
$format.Trimming = [System.Drawing.StringTrimming]::None
$palette = @(
  '#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0',
  '#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'
)
function Color256([int]$index) {
  if ($index -lt 0 -or $index -gt 255) { throw "Invalid ANSI color index $index" }
  if ($index -lt 16) { return [System.Drawing.ColorTranslator]::FromHtml($palette[$index]) }
  if ($index -ge 232) {
    $v = 8 + 10 * ($index - 232)
    return [System.Drawing.Color]::FromArgb($v, $v, $v)
  }
  $n = $index - 16
  $levels = @(0, 95, 135, 175, 215, 255)
  return [System.Drawing.Color]::FromArgb($levels[[int][Math]::Floor($n / 36)], $levels[[int][Math]::Floor(($n % 36) / 6)], $levels[$n % 6])
}
function ColorRgb([int]$r, [int]$g, [int]$b) {
  return [System.Drawing.Color]::FromArgb($r, $g, $b)
}
function Wide([int]$code) {
  return ($code -ge 0x1100 -and ($code -le 0x115f -or $code -eq 0x2329 -or $code -eq 0x232a -or
    ($code -ge 0x2e80 -and $code -le 0xa4cf) -or ($code -ge 0xac00 -and $code -le 0xd7a3) -or
    ($code -ge 0xf900 -and $code -le 0xfaff) -or ($code -ge 0xfe10 -and $code -le 0xfe6f) -or
    ($code -ge 0xff00 -and $code -le 0xff60) -or ($code -ge 0xffe0 -and $code -le 0xffe6) -or
    ($code -ge 0x1f300 -and $code -le 0x1faff) -or ($code -ge 0x20000 -and $code -le 0x3fffd)))
}
try {
  $text = [System.IO.File]::ReadAllText($AnsiPath, [System.Text.Encoding]::UTF8)
  $defaultFg = [System.Drawing.Color]::FromArgb(230, 230, 230)
  $defaultBg = [System.Drawing.Color]::FromArgb(18, 18, 18)
  $fg = $defaultFg; $bg = $defaultBg; $bold = $false; $dim = $false
  $x = 0; $y = 0; $i = 0
  while ($i -lt $text.Length -and $y -lt $Rows) {
    $ch = $text[$i]
    if ([int]$ch -eq 27) {
      $match = [regex]::Match($text.Substring($i), '^\x1b\[([0-9;:]*)([ -/]*)([@-~])')
      if (-not $match.Success) { throw "Unsupported ANSI escape at offset $i" }
      $i += $match.Length
      if ($match.Groups[3].Value -ne 'm') { continue }
      $raw = $match.Groups[1].Value
      $codes = if ($raw -eq '') { @(0) } else { @($raw.Split(';') | ForEach-Object { if ($_ -eq '') { 0 } else { [int]$_ } }) }
      for ($j = 0; $j -lt $codes.Count; $j++) {
        $c = $codes[$j]
        if ($c -eq 0) { $fg = $defaultFg; $bg = $defaultBg; $bold = $false; $dim = $false }
        elseif ($c -eq 1) { $bold = $true }
        elseif ($c -eq 2) { $dim = $true }
        elseif ($c -eq 22) { $bold = $false; $dim = $false }
        elseif ($c -eq 39) { $fg = $defaultFg }
        elseif ($c -eq 49) { $bg = $defaultBg }
        elseif ($c -ge 30 -and $c -le 37) { $fg = Color256 ($c - 30) }
        elseif ($c -ge 90 -and $c -le 97) { $fg = Color256 ($c - 90 + 8) }
        elseif ($c -ge 40 -and $c -le 47) { $bg = Color256 ($c - 40) }
        elseif ($c -ge 100 -and $c -le 107) { $bg = Color256 ($c - 100 + 8) }
        elseif ($c -eq 38 -or $c -eq 48) {
          if ($j + 2 -ge $codes.Count) { throw 'Incomplete ANSI color' }
          if ($codes[$j + 1] -eq 5) { $color = Color256 $codes[$j + 2]; $j += 2 }
          elseif ($codes[$j + 1] -eq 2 -and $j + 4 -lt $codes.Count) {
            $color = ColorRgb $codes[$j + 2] $codes[$j + 3] $codes[$j + 4]; $j += 4
          } else { throw 'Unsupported ANSI color' }
          if ($c -eq 38) { $fg = $color } else { $bg = $color }
        }
      }
      continue
    }
    if ($ch -eq "`r") { $x = 0; $i++; continue }
    if ($ch -eq "`n") { $x = 0; $y++; $i++; continue }
    if ([char]::IsControl($ch)) { $i++; continue }
    $code = [char]::ConvertToUtf32($text, $i)
    $glyph = [char]::ConvertFromUtf32($code)
    $i += $glyph.Length
    $width = if (Wide $code) { 2 } else { 1 }
    if ($x -ge $Columns) { continue }
    $paint = if ($dim) {
      [System.Drawing.Color]::FromArgb([int](($fg.R + $bg.R) / 2), [int](($fg.G + $bg.G) / 2), [int](($fg.B + $bg.B) / 2))
    } else { $fg }
    $background = New-Object System.Drawing.SolidBrush($bg)
    $foreground = New-Object System.Drawing.SolidBrush($paint)
    try {
      $graphics.FillRectangle($background, ($x * $cellWidth), ($y * $cellHeight), ([Math]::Min($width, $Columns - $x) * $cellWidth), $cellHeight)
      $drawFont = if ($bold) { $boldFont } else { $font }
      $graphics.DrawString($glyph, $drawFont, $foreground, [float]($x * $cellWidth), [float]($y * $cellHeight), $format)
    } finally { $background.Dispose(); $foreground.Dispose() }
    $x += $width
  }
  $bitmap.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  @{ font = $fontName; fontSizePixels = $fontSize; cellWidth = $cellWidth; cellHeight = $cellHeight;
    width = $bitmap.Width; height = $bitmap.Height } | ConvertTo-Json -Compress
} finally {
  $format.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $font.Dispose(); $boldFont.Dispose()
}
