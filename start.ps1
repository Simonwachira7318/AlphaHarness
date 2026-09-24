# Start Alpha Harness for development: backend and frontend, each in its own window.
# Ports come from .env (AH_PORT, AH_UI_PORT). Close a window, or press Ctrl+C in it, to stop that half.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Get-EnvValue([string]$name, [string]$default) {
    $file = Join-Path $root '.env'
    if (Test-Path $file) {
        $line = Get-Content $file | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
        if ($line) { return ($line -split '=', 2)[1].Trim() }
    }
    return $default
}

# uv on PATH, or the copy pip installs, run through Python.
if (Get-Command uv -ErrorAction SilentlyContinue) { $uv = 'uv' } else { $uv = 'python -m uv' }

$apiPort = Get-EnvValue 'AH_PORT' '8005'
$uiPort = Get-EnvValue 'AH_UI_PORT' '5175'

foreach ($port in $apiPort, $uiPort) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "Port $port is already in use. Stop whatever holds it, or change it in .env." -ForegroundColor Red
        exit 1
    }
}

Start-Process powershell -WorkingDirectory "$root\backend" -ArgumentList '-NoExit', '-Command', "$uv run python -m alpha_harness.dev"
Start-Process powershell -WorkingDirectory "$root\frontend" -ArgumentList '-NoExit', '-Command', 'pnpm dev'

Write-Host "Backend on port $apiPort, UI on port $uiPort. Opening the browser..."
Start-Sleep -Seconds 6
Start-Process "http://localhost:$uiPort"
