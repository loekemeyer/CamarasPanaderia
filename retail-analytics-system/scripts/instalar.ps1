# Instalador de 1 clic para Windows 10/11 (PC existente del local).
# Instala Docker Desktop si falta, genera la clave de administración,
# levanta el sistema, lo deja arrancando solo y crea accesos directos.
# Continue: en PowerShell 5.1, con "Stop" la salida de error de docker corta el script.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Paso($t) { Write-Host "`n==> $t" -ForegroundColor Magenta }
function Ok($t)   { Write-Host "    $t" -ForegroundColor Green }
function Aviso($t){ Write-Host "    $t" -ForegroundColor Yellow }

# 1. Docker Desktop -------------------------------------------------------------
Paso "Verificando Docker Desktop"
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Aviso "Falta 'winget'. Instalá 'App Installer' desde Microsoft Store y volvé a ejecutar."
        exit 1
    }
    Aviso "Docker Desktop no está instalado. Instalando (gratis para comercios chicos)..."
    winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    Write-Host ""
    Aviso "Docker quedó instalado. REINICIÁ la computadora y ejecutá INSTALAR-WINDOWS.bat de nuevo."
    exit 0
}
Ok "Docker encontrado"

# 2. Docker corriendo -------------------------------------------------------------
Paso "Iniciando Docker"
$dockerExe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
docker info *> $null
if ($LASTEXITCODE -ne 0 -and (Test-Path $dockerExe)) { Start-Process $dockerExe }
$deadline = (Get-Date).AddMinutes(4)
do {
    Start-Sleep -Seconds 3
    docker info *> $null
} until ($LASTEXITCODE -eq 0 -or (Get-Date) -gt $deadline)
if ($LASTEXITCODE -ne 0) {
    Aviso "Docker no respondió. Abrí 'Docker Desktop', aceptá los términos y volvé a ejecutar."
    exit 1
}
Ok "Docker listo"

# Que Docker arranque solo al iniciar Windows (el sistema se levanta con él).
foreach ($f in @("$env:APPDATA\Docker\settings-store.json", "$env:APPDATA\Docker\settings.json")) {
    if (Test-Path $f) {
        try {
            $json = Get-Content $f -Raw | ConvertFrom-Json
            if ($f -like "*settings-store.json") { $json | Add-Member -Force AutoStart $true } else { $json | Add-Member -Force autoStart $true }
            $json | ConvertTo-Json -Depth 20 | Set-Content $f -Encoding UTF8
        } catch { }
    }
}

# 3. Configuración inicial --------------------------------------------------------
Paso "Preparando configuración"
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Root ".env.example") $envFile
    $chars = "abcdefghjkmnpqrstuvwxyz23456789".ToCharArray()
    $pass = -join (1..10 | ForEach-Object { $chars | Get-Random })
    $dbpass = -join (1..24 | ForEach-Object { $chars | Get-Random })
    (Get-Content $envFile) `
        -replace '^ADMIN_PASSWORD=.*', "ADMIN_PASSWORD=$pass" `
        -replace '^POSTGRES_PASSWORD=.*', "POSTGRES_PASSWORD=$dbpass" `
        -replace '^VIDEO_SOURCE=.*', 'VIDEO_SOURCE=/data/sample.mp4' |
        Set-Content $envFile -Encoding UTF8
    Ok "Clave de administración generada"
} else {
    Ok "Se conserva la configuración existente"
}
$pass = ((Get-Content $envFile | Where-Object { $_ -like "ADMIN_PASSWORD=*" }) -replace '^ADMIN_PASSWORD=', '')

# 4. Levantar ------------------------------------------------------------------------
Paso "Construyendo y levantando el sistema (la primera vez tarda 10-20 minutos)"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Aviso "Falló docker compose. Revisá la conexión a internet y reintentá."; exit 1 }
Ok "Sistema en marcha"

# 5. Acceso desde celulares de la misma red -------------------------------------------
try {
    if (-not (Get-NetFirewallRule -DisplayName "Analitica Panaderia" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "Analitica Panaderia" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private | Out-Null
    }
} catch { Aviso "No se pudo abrir el puerto 8080 en el firewall (hace falta permiso de administrador)." }

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254*" -and $_.InterfaceAlias -notmatch "vEthernet|WSL|Docker|Loopback" } |
    Select-Object -First 1).IPAddress

# 6. Accesos directos -------------------------------------------------------------------
$desktop = [Environment]::GetFolderPath("Desktop")
"[InternetShortcut]`r`nURL=http://localhost:8080`r`n" | Set-Content (Join-Path $desktop "Panel Panaderia.url") -Encoding ASCII
@"
PANEL DE ANALITICA DE CAMARAS
=============================
En esta computadora:   http://localhost:8080
Desde el celular (misma Wi-Fi del local):   http://$($ip):8080

Clave de Configuracion:   $pass

Primer uso: Configuracion > Camara > "Buscar camaras en la red".
Guarda este archivo en un lugar seguro.
"@ | Set-Content (Join-Path $desktop "Panel Panaderia - ACCESO.txt") -Encoding UTF8

Write-Host ""
Write-Host "  LISTO" -ForegroundColor Green
Write-Host "  En esta PC:     http://localhost:8080"
Write-Host "  En el celular:  http://$($ip):8080   (conectado a la Wi-Fi del local)"
Write-Host "  Clave:          $pass"
Write-Host "  (Quedó todo anotado en el escritorio: 'Panel Panaderia - ACCESO.txt')"
Start-Process "http://localhost:8080/#/configuracion/camara"
