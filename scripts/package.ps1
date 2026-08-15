param(
    [string]$Configuration = "Release",
    [string]$Version = "2.0.0",
    [switch]$NoRestore
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root "frontend"
$project = Join-Path $root "src\DuplicateManager\DuplicateManager.csproj"
$publishDir = Join-Path $root "artifacts\extension"
$zipPath = Join-Path $root "artifacts\io.github.jiwenjimiran.duplicate-manager-$Version.zip"

if (-not $env:COVE_HOST_ASSEMBLY_DIR) {
    $cove = Get-Process Cove -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cove) {
        $core = $cove.Modules | Where-Object ModuleName -eq "Cove.Core.dll" | Select-Object -First 1
        if ($core) { $env:COVE_HOST_ASSEMBLY_DIR = Split-Path -Parent $core.FileName }
    }
}
if (-not $env:COVE_HOST_ASSEMBLY_DIR) {
    throw "Cove 1.1.0 must be running, or COVE_HOST_ASSEMBLY_DIR must point to its extracted assemblies."
}
$hostArg = "-p:CoveHostAssemblyDir=$env:COVE_HOST_ASSEMBLY_DIR"

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
    dotnet restore $project -p:UseLocalCovePlugins=false $hostArg
    if ($LASTEXITCODE -ne 0) { throw "Extension restore failed with exit code $LASTEXITCODE." }
}
dotnet build $project -c $Configuration -p:UseLocalCovePlugins=false $hostArg --no-restore
if ($LASTEXITCODE -ne 0) { throw "Extension build failed with exit code $LASTEXITCODE." }
dotnet publish $project -c $Configuration -o $publishDir -p:UseLocalCovePlugins=false $hostArg --no-build --no-restore
if ($LASTEXITCODE -ne 0) { throw "Extension publish failed with exit code $LASTEXITCODE." }
Compress-Archive -Path (Join-Path $publishDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
