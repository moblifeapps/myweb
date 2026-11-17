# update-gallery.ps1 — MLApplications
# Rebuilds videos.json (and thumbs/) for the background-video gallery used by pptx-test.html.
#
# Usage (from this folder):   powershell -ExecutionPolicy Bypass -File .\update-gallery.ps1
#
# - Scans *.mp4, *.webm, *.mov, *.m4v in this folder.
# - Keeps titles you already edited in videos.json; new clips get a title from the file name.
# - If ffmpeg/ffprobe are on PATH, it also reads size/duration and creates a poster (.jpg)
#   and a 4-second hover preview (.preview.mp4) in thumbs/, plus a light 1080p web copy in web/
#   (what the page streams as the background). Without ffmpeg the gallery still works, it just
#   streams the original file and uses the video itself for the thumbnail.

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$jsonPath = Join-Path $dir 'videos.json'
$thumbs = Join-Path $dir 'thumbs'
$webDir = Join-Path $dir 'web'
New-Item -ItemType Directory -Force -Path $thumbs | Out-Null
New-Item -ItemType Directory -Force -Path $webDir | Out-Null

# Existing titles (so manual edits survive)
$oldTitles = @{}
if (Test-Path $jsonPath) {
    try {
        $old = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($v in $old.videos) { $oldTitles[$v.file] = $v.title }
    } catch { Write-Warning "Could not read existing videos.json: $_" }
}

$hasFfmpeg = [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue) -and [bool](Get-Command ffprobe -ErrorAction SilentlyContinue)
if (-not $hasFfmpeg) { Write-Warning 'ffmpeg/ffprobe not found on PATH - skipping posters, previews and metadata.' }

$items = @()
$files = Get-ChildItem -Path $dir -File | Where-Object { $_.Extension -match '^\.(mp4|webm|mov|m4v)$' } | Sort-Object Name
foreach ($f in $files) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    $title = $oldTitles[$f.Name]
    if (-not $title) {
        $title = ($base -replace '[-_]+', ' ' -replace '\b(hd|uhd|pixabay)\b', '' -replace '\b\d{3,}\b', '' -replace '\s+', ' ').Trim()
        if (-not $title) { $title = $base }
        $title = (Get-Culture).TextInfo.ToTitleCase($title)
    }
    $item = [ordered]@{ file = $f.Name; title = $title; size = $f.Length }

    if ($hasFfmpeg) {
        $probe = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json $f.FullName | ConvertFrom-Json
        if ($probe.streams) {
            $item.width = [int]$probe.streams[0].width
            $item.height = [int]$probe.streams[0].height
        }
        if ($probe.format.duration) { $item.duration = [math]::Round([double]$probe.format.duration, 2) }

        $poster = Join-Path $thumbs "$base.jpg"
        $preview = Join-Path $thumbs "$base.preview.mp4"
        if (-not (Test-Path $poster)) {
            Write-Host "Poster:  $($f.Name)"
            & ffmpeg -loglevel error -y -ss 1 -i $f.FullName -frames:v 1 -vf 'scale=480:-2' -q:v 4 $poster
        }
        if (-not (Test-Path $preview)) {
            Write-Host "Preview: $($f.Name)"
            & ffmpeg -loglevel error -y -ss 0.5 -t 4 -i $f.FullName -an -vf 'scale=480:-2,fps=24' -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +faststart $preview
        }
        $web = Join-Path $webDir $f.Name
        if (-not (Test-Path $web)) {
            Write-Host "Web copy: $($f.Name)  (1080p, may take a minute)"
            & ffmpeg -loglevel error -y -i $f.FullName -an -vf "scale='min(1920,iw)':-2,fps=30" -c:v libx264 -preset medium -crf 25 -maxrate 6M -bufsize 12M -g 60 -pix_fmt yuv420p -movflags +faststart $web
        }
        if (Test-Path $web) { $item.web = "web/$($f.Name)"; $item.webSize = (Get-Item $web).Length }
        if (Test-Path $poster) { $item.poster = "thumbs/$base.jpg" }
        if (Test-Path $preview) { $item.preview = "thumbs/$base.preview.mp4" }
    }
    $items += [pscustomobject]$item
}

$json = [ordered]@{ videos = $items } | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "videos.json updated: $($items.Count) clip(s)."
