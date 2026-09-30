param(
    [string]$Configuration = "Release",
    [string]$Version = "2.1.0",
    [switch]$NoRestore,
    [string]$CoveSourceRoot
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root "frontend"
$project = Join-Path $root "src\DuplicateManager\DuplicateManager.csproj"
$regressionProject = Join-Path $root "tests\DuplicateManager.RegressionTests\DuplicateManager.RegressionTests.csproj"
$publishDir = Join-Path $root "artifacts\extension-$Version"
$zipPath = Join-Path $root "artifacts\io.github.jiwenjimiran.duplicate-manager-$Version.zip"

if (-not $CoveSourceRoot) {
    $pinnedSource = Join-Path $root "artifacts\cove-v1.5.1"
    if (Test-Path -LiteralPath (Join-Path $pinnedSource "src\Cove.Data\Cove.Data.csproj")) {
        $CoveSourceRoot = $pinnedSource
    } else {
        throw "Pass -CoveSourceRoot pointing to a Cove v1.5.1 source checkout (see README)."
    }
}
$CoveSourceRoot = (Resolve-Path -LiteralPath $CoveSourceRoot).Path
$buildArgs = @("-p:UseLocalCovePlugins=true", "-p:CoveSourceRoot=$CoveSourceRoot")
$manifest = Get-Content -LiteralPath (Join-Path $root "src\DuplicateManager\extension.json") -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) { throw "Package version must match extension.json ($($manifest.version))." }
# Keep cleanup inside the explicitly resolved artifacts directory.
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $root "artifacts")) + [IO.Path]::DirectorySeparatorChar
foreach ($target in @($publishDir, $zipPath)) {
    if (-not [IO.Path]::GetFullPath($target).StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Package output must stay inside $artifactRoot"
    }
}

Push-Location $frontend
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}

dotnet run --project $regressionProject -c $Configuration @buildArgs
if ($LASTEXITCODE -ne 0) { throw "Backend regression tests failed with exit code $LASTEXITCODE." }

if (Test-Path -LiteralPath $publishDir) {
    Remove-Item -LiteralPath $publishDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

if (-not $NoRestore) {
    dotnet restore $project @buildArgs
    if ($LASTEXITCODE -ne 0) { throw "Extension restore failed with exit code $LASTEXITCODE." }
}
dotnet build $project -c $Configuration @buildArgs --no-restore
if ($LASTEXITCODE -ne 0) { throw "Extension build failed with exit code $LASTEXITCODE." }
dotnet publish $project -c $Configuration -o $publishDir @buildArgs -p:BuildProjectReferences=false --no-build --no-restore
if ($LASTEXITCODE -ne 0) { throw "Extension publish failed with exit code $LASTEXITCODE." }
Compress-Archive -Path (Join-Path $publishDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
