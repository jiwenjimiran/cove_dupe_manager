param(
    [string]$Configuration = "Release",
    [string]$Version = "1.9.2",
    [switch]$NoRestore
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root "frontend"
$project = Join-Path $root "src\DuplicateManager\DuplicateManager.csproj"
$publishDir = Join-Path $root "artifacts\extension"
$zipPath = Join-Path $root "artifacts\io.github.jiwenjimiran.duplicate-manager-$Version.zip"

Push-Location $frontend
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE." }
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

if (Test-Path -LiteralPath $publishDir) {
    Remove-Item -LiteralPath $publishDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

if (-not $NoRestore) {
    dotnet restore $project -p:UseLocalCovePlugins=false
    if ($LASTEXITCODE -ne 0) { throw "Extension restore failed with exit code $LASTEXITCODE." }
}
dotnet build $project -c $Configuration -p:UseLocalCovePlugins=false --no-restore
if ($LASTEXITCODE -ne 0) { throw "Extension build failed with exit code $LASTEXITCODE." }
dotnet publish $project -c $Configuration -o $publishDir -p:UseLocalCovePlugins=false --no-build --no-restore
if ($LASTEXITCODE -ne 0) { throw "Extension publish failed with exit code $LASTEXITCODE." }
Compress-Archive -Path (Join-Path $publishDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
