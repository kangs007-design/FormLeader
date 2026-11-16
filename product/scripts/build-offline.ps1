param([string]$Maven = 'mvn', [switch]$Offline)
$ErrorActionPreference = 'Stop'
$productRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $productRoot
$bundle = Join-Path $productRoot 'offline'
$mavenArgs = @('-B', '-ntp', '-f', (Join-Path $productRoot 'was/pom.xml'))
if ($Offline) { $mavenArgs += '-o' }
& $Maven @mavenArgs package
if ($LASTEXITCODE -ne 0) { throw 'WAR build or tests failed.' }
New-Item -ItemType Directory -Path "$bundle/lib", "$bundle/web" -Force | Out-Null
& $Maven @mavenArgs dependency:copy '-Dartifact=org.mariadb.jdbc:mariadb-java-client:4.0.0' "-DoutputDirectory=$bundle/lib"
if ($LASTEXITCODE -ne 0) { throw 'JDBC driver packaging failed.' }
Copy-Item -LiteralPath (Join-Path $productRoot 'was/target/ROOT.war') -Destination "$bundle/ROOT.war" -Force
Copy-Item -Path (Join-Path $repositoryRoot 'src/web/*') -Destination "$bundle/web" -Recurse -Force
Copy-Item -Path (Join-Path $productRoot 'deploy'), (Join-Path $productRoot 'db') -Destination $bundle -Recurse -Force
Copy-Item -LiteralPath (Join-Path $productRoot 'compose.yaml'), (Join-Path $productRoot '.env.example') -Destination $bundle -Force
# The portable bundle's compose paths point at its own artifacts.
$compose = Get-Content -LiteralPath "$bundle/compose.yaml" -Raw
$compose.Replace('./offline/', './') | Set-Content -LiteralPath "$bundle/compose.yaml" -Encoding utf8
Copy-Item -LiteralPath (Join-Path $productRoot 'README.md') -Destination "$bundle/README.md" -Force
Copy-Item -LiteralPath (Join-Path $productRoot 'VERIFICATION.md') -Destination "$bundle/VERIFICATION.md" -Force
Get-ChildItem -LiteralPath $bundle -File -Recurse | Where-Object Name -ne 'SHA256SUMS' | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($bundle, $_.FullName).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
} | Set-Content -LiteralPath "$bundle/SHA256SUMS" -Encoding ascii
Write-Host "Offline artifacts: $bundle (runtime images must be saved separately; see README)"
