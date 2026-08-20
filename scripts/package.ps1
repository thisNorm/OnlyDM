param(
    [ValidateSet("win-x64", "win-arm64")]
    [string]$RuntimeIdentifier = "win-x64"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$publishRoot = Join-Path $root "artifacts\publish"
$publishDir = Join-Path $publishRoot $RuntimeIdentifier
$zipPath = Join-Path $root "artifacts\OnlyDM-$RuntimeIdentifier.zip"
$checksumPath = "$zipPath.sha256"
$project = Join-Path $root "src\OnlyDM\OnlyDM.csproj"

if (Test-Path $publishDir) {
    Remove-Item $publishDir -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}
if (Test-Path $checksumPath) {
    Remove-Item $checksumPath -Force
}

New-Item -ItemType Directory -Force -Path $publishDir | Out-Null

Write-Host "Publishing OnlyDM ($RuntimeIdentifier)..." -ForegroundColor Cyan
dotnet publish $project `
    -c Release `
    -r $RuntimeIdentifier `
    --self-contained true `
    -p:PublishSingleFile=false `
    -o $publishDir

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed."
}

$cliDir = Join-Path $publishDir "cli"
New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
Copy-Item -LiteralPath (Join-Path $root "cli\odm.ps1") -Destination (Join-Path $cliDir "odm.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "cli\odm.cmd") -Destination (Join-Path $cliDir "odm.cmd") -Force
Copy-Item -LiteralPath (Join-Path $root "install.ps1") -Destination (Join-Path $publishDir "install.ps1") -Force
Copy-Item -LiteralPath (Join-Path $root "uninstall.ps1") -Destination (Join-Path $publishDir "uninstall.ps1") -Force

Compress-Archive -Path (Join-Path $publishDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($checksumPath, $hash + [Environment]::NewLine, [Text.Encoding]::ASCII)

Write-Host "Created: $zipPath" -ForegroundColor Green
Write-Host "SHA-256: $hash" -ForegroundColor Green
Write-Host "Checksum: $checksumPath" -ForegroundColor Green
