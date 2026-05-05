# Pinkbin pixel-art logo generator. Outputs 32/128/256 PNGs and a multi-size ICO.
# Cute pink trash can. 24x24 source pixel grid, nearest-neighbour upscale.
#
# Run from repo root:  pwsh scripts/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$design = @(
    '........................',
    '........................',
    '..........IIIIII........',
    '.........I......I.......',
    '.......IIIIIIIIIIII.....',
    '......ILLLLLLLLLLLLI....',
    '......IPPPPPWPPPPPPI....',
    '......IDDDDDDDDDDDDI....',
    '........................',
    '.....IIIIIIIIIIIIIIII...',
    '....ILLLLLLLLLLLLLLLLI..',
    '....IPPPIIPPPPPIIPPPPI..',
    '....IPPPIIPPPPPIIPPPPI..',
    '....IPPPPPPPPPPPPPPPPI..',
    '....IPPPPPIIIIIIPPPPPI..',
    '....IPPPPPPIIIIPPPPPPI..',
    '....IPPPPPPPPPPPPPPPPI..',
    '....IPPPPPPPPPPPPPPPPI..',
    '....IPPPPPPPPPPPPPPPPI..',
    '....IDDDDDDDDDDDDDDDDI..',
    '.....IIIIIIIIIIIIIIII...',
    '........................',
    '........................',
    '........................'
)

# Verify each row is 24 chars.
foreach ($r in $design) {
    if ($r.Length -ne 24) { throw "row not 24 chars: '$r' ($($r.Length))" }
}
if ($design.Count -ne 24) { throw "expected 24 rows, got $($design.Count)" }

$colors = @{}
$colors['I'] = [System.Drawing.Color]::FromArgb(255, 21, 8, 24)
$colors['L'] = [System.Drawing.Color]::FromArgb(255, 255, 208, 224)
$colors['P'] = [System.Drawing.Color]::FromArgb(255, 255, 111, 168)
$colors['D'] = [System.Drawing.Color]::FromArgb(255, 226, 63, 134)
$colors['W'] = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

$src = New-Object System.Drawing.Bitmap 24, 24
for ($y = 0; $y -lt 24; $y++) {
    $row = $design[$y]
    for ($x = 0; $x -lt 24; $x++) {
        $ch = [string]$row[$x]
        if ($colors.ContainsKey($ch)) {
            $src.SetPixel($x, $y, $colors[$ch])
        }
    }
}

function Save-Pixel-Png {
    param($srcBmp, [int]$size, [string]$outPath)
    $out = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.DrawImage($srcBmp, 0, 0, $size, $size)
    $g.Dispose()
    $out.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
}

$iconDir = Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\icons"
$iconDir = (Resolve-Path $iconDir).Path
Write-Host "writing icons to $iconDir"

Save-Pixel-Png $src 32  (Join-Path $iconDir '32x32.png')
Save-Pixel-Png $src 128 (Join-Path $iconDir '128x128.png')
Save-Pixel-Png $src 256 (Join-Path $iconDir '128x128@2x.png')
Save-Pixel-Png $src 512 (Join-Path $iconDir 'icon.png')

# Build ICO with classic BMP entries — RC.exe (Windows resource compiler)
# silently strips PNG-in-ICO entries, so we have to use the legacy format
# the resource compiler actually understands.
function Build-IcoBmpEntry {
    param($srcBmp, [int]$size)

    $resized = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($resized)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.DrawImage($srcBmp, 0, 0, $size, $size)
    $g.Dispose()

    $imgBytes = $size * $size * 4
    # AND mask is 1 bit/pixel, rows padded to 4 bytes.
    $maskRowBytes = [int][Math]::Ceiling($size / 32.0) * 4
    $maskBytes = $maskRowBytes * $size

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms

    # BITMAPINFOHEADER
    $bw.Write([uint32]40)              # biSize
    $bw.Write([int32]$size)            # biWidth
    $bw.Write([int32]($size * 2))      # biHeight (doubled — XOR + AND mask)
    $bw.Write([uint16]1)               # biPlanes
    $bw.Write([uint16]32)              # biBitCount
    $bw.Write([uint32]0)               # biCompression (BI_RGB)
    $bw.Write([uint32]$imgBytes)       # biSizeImage (XOR data only)
    $bw.Write([int32]0)                # biXPelsPerMeter
    $bw.Write([int32]0)                # biYPelsPerMeter
    $bw.Write([uint32]0)               # biClrUsed
    $bw.Write([uint32]0)               # biClrImportant

    # XOR pixel data: bottom-up BGRA.
    for ($y = $size - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $size; $x++) {
            $px = $resized.GetPixel($x, $y)
            $bw.Write([byte]$px.B)
            $bw.Write([byte]$px.G)
            $bw.Write([byte]$px.R)
            $bw.Write([byte]$px.A)
        }
    }
    # AND mask: all zeros — alpha channel already encodes transparency.
    $zeros = [byte[]]::new($maskBytes)
    $bw.Write($zeros)

    $resized.Dispose()
    [byte[]]$result = $ms.ToArray()
    # Comma operator stops PowerShell from unrolling the byte[] into the pipeline.
    return ,$result
}

$sizes = @(16, 32, 48, 64, 128, 256)
$entries = @()
foreach ($s in $sizes) {
    $bytes = Build-IcoBmpEntry $src $s
    $entries += [pscustomobject]@{ Size = $s; Bytes = $bytes }
}

$icoPath = Join-Path $iconDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs

# ICONDIR header.
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$entries.Count)

$offset = 6 + (16 * $entries.Count)
foreach ($e in $entries) {
    $w = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $h = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$w)
    $bw.Write([byte]$h)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$e.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $e.Bytes.Length
}
foreach ($e in $entries) { $bw.Write($e.Bytes) }

$bw.Close()
$fs.Close()
$src.Dispose()

Write-Host "wrote $icoPath ($((Get-Item $icoPath).Length) bytes)"
