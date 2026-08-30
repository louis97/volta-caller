# Instala/actualiza Render CLI y prepara el despliegue de volta-api.
$ErrorActionPreference = "Stop"

$renderDir = Join-Path $env:LOCALAPPDATA "Programs\render"
$renderExe = Join-Path $renderDir "render.exe"
$zipPath = Join-Path $env:TEMP "render-cli.zip"
$releaseUrl = "https://github.com/render-oss/cli/releases/download/v2.25.0/cli_2.25.0_windows_amd64.zip"

if (-not (Test-Path $renderExe)) {
  Write-Host "Descargando Render CLI..."
  curl.exe -L -o $zipPath $releaseUrl
  New-Item -ItemType Directory -Force -Path $renderDir | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $renderDir -Force
}

if ($env:Path -notlike "*$renderDir*") {
  $env:Path = "$renderDir;$env:Path"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$renderDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$renderDir", "User")
    Write-Host "Render CLI agregado al PATH de usuario."
  }
}

& $renderExe --version

Write-Host ""
Write-Host "Siguiente paso: autenticarse con Render"
Write-Host "  render login"
Write-Host ""
Write-Host "Luego valida y despliega desde la raíz del repo:"
Write-Host "  render blueprints validate render.yaml"
Write-Host "  render services create --name volta-api --type web_service --runtime node --region virginia --plan free --repo https://github.com/louis97/volta-caller --branch main --build-command `"npm ci`" --start-command `"npm run start:api`" --health-check-path /health --output json"
Write-Host ""
Write-Host "Documentación completa: docs/deploy-render-vercel.md"
