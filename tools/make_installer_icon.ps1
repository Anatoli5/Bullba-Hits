# Render the existing shield mark as a multi-resolution Windows icon.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconOutput = Join-Path (Split-Path $PSScriptRoot -Parent) 'installer\armor-inspector.ico'
$iconFolder = Split-Path $iconOutput -Parent
New-Item -ItemType Directory -Path $iconFolder -Force | Out-Null
$sourceBitmap = New-Object Drawing.Bitmap 768,768
$graphics = [Drawing.Graphics]::FromImage($sourceBitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.ColorTranslator]::FromHtml('#111a24'))
$graphics.ScaleTransform(4,4)
$pen = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#eac36e')),6
[Drawing.PointF[]]$points = @([Drawing.PointF]::new(35,48),[Drawing.PointF]::new(96,23),[Drawing.PointF]::new(157,48),[Drawing.PointF]::new(157,102),[Drawing.PointF]::new(96,169),[Drawing.PointF]::new(35,102))
$graphics.DrawPolygon($pen,$points)
$graphics.DrawLine($pen,47,122,145,55)
$graphics.DrawLine($pen,96,43,96,147)
$graphics.DrawLine($pen,54,91,138,91)
$graphics.Dispose(); $pen.Dispose()
$iconFrames = @()
foreach ($iconSize in @(16,24,32,48,64,128,256)) {
    $bitmap = New-Object Drawing.Bitmap $iconSize,$iconSize
    $canvas = [Drawing.Graphics]::FromImage($bitmap)
    $canvas.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $canvas.DrawImage($sourceBitmap,0,0,$iconSize,$iconSize)
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    if ($iconSize -eq 64) { [IO.File]::WriteAllBytes((Join-Path (Split-Path $PSScriptRoot -Parent) 'web\menu-icon.png'), $stream.ToArray()) }
    $iconFrames += [PSCustomObject]@{Size=$iconSize;Bytes=$stream.ToArray()}
    $stream.Dispose(); $canvas.Dispose(); $bitmap.Dispose()
}
$sourceBitmap.Dispose()
$iconStream = [IO.File]::Create($iconOutput)
$writer = New-Object IO.BinaryWriter $iconStream
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$iconFrames.Count)
    $offset = 6 + 16 * $iconFrames.Count
    foreach ($frame in $iconFrames) {
        $sizeByte = [byte]($frame.Size % 256)
        $writer.Write($sizeByte); $writer.Write($sizeByte); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $iconFrames) { $writer.Write([byte[]]$frame.Bytes) }
} finally { $writer.Dispose() }
Write-Output $iconOutput
