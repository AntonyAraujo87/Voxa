# Executado apenas na VM descartavel do GitHub Actions, nunca no PC do usuario.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or !$env:RUNNER_TEMP) {
    throw 'Este teste instala/desinstala o Voxa e exige o runner Windows descartavel do GitHub.'
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versao invalida' }
$testRoot = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) 'voxa-installer-smoke'
$installDir = Join-Path $testRoot 'installed'
$newInstaller = Join-Path $env:GITHUB_WORKSPACE "src-tauri/target/release/bundle/nsis/Voxa_${Version}_x64-setup.exe"
$installedExe = Join-Path $installDir 'voxa.exe'
if (Test-Path -LiteralPath $testRoot) { throw 'Diretorio de teste ja existe; nao reutilizar instalacao anterior' }
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Run-Installer([string]$File, [string[]]$Arguments) {
    if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw "Pacote ausente: $File" }
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (!$process.WaitForExit(180000)) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        throw 'Instalador excedeu 180 segundos'
    }
    if ($process.ExitCode -notin @(0, 3010)) { throw "Instalador retornou $($process.ExitCode)" }
}

function Check-Installed([string]$ExpectedHash = '') {
    if (!(Test-Path -LiteralPath $installedExe)) { throw 'Executavel nao instalado no destino esperado' }
    $installedHash = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
    if ($ExpectedHash -and $installedHash -ne $ExpectedHash) {
        throw 'O mesmo pacote instalou executaveis diferentes entre as rodadas'
    }
    $productVersion = (Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion
    if ($productVersion -notmatch "^$([regex]::Escape($Version))(?:\D|$)") {
        throw "Executavel instalado tem versao inesperada: $productVersion"
    }
    $nativeResult = & node scripts/check-native.mjs $installedExe
    if ($LASTEXITCODE -ne 0) { throw 'Dependencias/manifests do executavel instalado invalidos' }
    Write-Host $nativeResult
    $app = Start-Process -FilePath $installedExe -PassThru -WindowStyle Hidden
    try {
        # Nao basta um processo preso numa caixa de DLL ausente: exigir WebView2 filho.
        $webviewReady = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 500
            $app.Refresh()
            if ($app.HasExited) { throw "Voxa encerrou durante startup: $($app.ExitCode)" }
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)")
            if (@($children | Where-Object Name -eq 'msedgewebview2.exe').Count -gt 0) { $webviewReady = $true; break }
        }
        if (!$webviewReady) { throw 'WebView2 nao iniciou; nao publicar um processo apenas vivo' }
        Start-Sleep -Seconds 3
        $app.Refresh()
        if ($app.HasExited) { throw 'Voxa encerrou depois de criar WebView2' }
    } finally {
        # Apenas o processo iniciado por este teste. Os subprocessos WebView encerram junto.
        if (!$app.HasExited) { Stop-Process -Id $app.Id -ErrorAction SilentlyContinue }
        $app.Dispose()
    }
    return $installedHash
}

function Uninstall-Test {
    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (!(Test-Path -LiteralPath $uninstaller)) { throw 'Desinstalador nao encontrado' }
    Run-Installer $uninstaller @('/S')
    for ($attempt = 0; $attempt -lt 60 -and (Test-Path -LiteralPath $installedExe); $attempt++) {
        Start-Sleep -Milliseconds 500
    }
    if (Test-Path -LiteralPath $installedExe) { throw 'Desinstalacao nao removeu o executavel' }
}

Run-Installer $newInstaller @('/S', "/D=$installDir")
$nsisHash = Check-Installed
Uninstall-Test
Write-Output 'PASS: instalacao limpa, dependencias, startup WebView2 e desinstalacao'

# Versao realmente publicada antes desta auditoria; download somente do proprio repositorio.
& gh release download v0.5.27 --repo $env:GITHUB_REPOSITORY --pattern 'Voxa_0.5.27_x64-setup.exe' --dir $testRoot
if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar instalador anterior' }
Run-Installer (Join-Path $testRoot 'Voxa_0.5.27_x64-setup.exe') @('/S', "/D=$installDir")
if (!(Test-Path -LiteralPath $installedExe)) { throw 'Versao anterior nao foi instalada' }
$oldVersion = (Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion
if ($oldVersion -notmatch '^0\.5\.27(?:\D|$)') { throw "Versao anterior inesperada: $oldVersion" }

# Preferencia real armazenada pelo backend; a atualizacao precisa preserva-la.
$bootDir = Join-Path $env:APPDATA 'com.voxa.app'
New-Item -ItemType Directory -Force -Path $bootDir | Out-Null
$bootPath = Join-Path $bootDir 'boot.json'
$bootContents = '{"capture_source":"","modo_seguro":true}'
Set-Content -LiteralPath $bootPath -Value $bootContents -NoNewline
Run-Installer $newInstaller @('/S', "/D=$installDir")
$null = Check-Installed -ExpectedHash $nsisHash
if ((Get-Content -LiteralPath $bootPath -Raw) -ne $bootContents) { throw 'Atualizacao perdeu a preferencia nativa' }
Uninstall-Test
Write-Output 'PASS: upgrade 0.5.27, executavel novo, startup e preferencia preservada'

# O manifesto antigo tambem oferece MSI ao updater. Exercitar esse pacote.
$newMsi = Join-Path $env:GITHUB_WORKSPACE "src-tauri/target/release/bundle/msi/Voxa_${Version}_x64_en-US.msi"
$msiExec = Join-Path $env:SystemRoot 'System32/msiexec.exe'
function Install-Msi([string]$File) {
    Run-Installer $msiExec @('/i', "`"$File`"", '/qn', '/norestart', "INSTALLDIR=`"$installDir`"")
}
function Uninstall-Msi {
    Run-Installer $msiExec @('/x', "`"$newMsi`"", '/qn', '/norestart')
    if (Test-Path -LiteralPath $installedExe) { throw 'Desinstalacao MSI deixou o executavel' }
}
Install-Msi $newMsi
$msiHash = Check-Installed
Uninstall-Msi
& gh release download v0.5.27 --repo $env:GITHUB_REPOSITORY --pattern 'Voxa_0.5.27_x64_en-US.msi' --dir $testRoot
if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar MSI anterior' }
Install-Msi (Join-Path $testRoot 'Voxa_0.5.27_x64_en-US.msi')
if (!(Test-Path -LiteralPath $installedExe)) { throw 'MSI anterior nao instalado' }
if ((Get-Item -LiteralPath $installedExe).VersionInfo.ProductVersion -notmatch '^0\.5\.27(?:\D|$)') { throw 'Versao MSI anterior inesperada' }
Set-Content -LiteralPath $bootPath -Value $bootContents -NoNewline
Install-Msi $newMsi
$null = Check-Installed -ExpectedHash $msiHash
if ((Get-Content -LiteralPath $bootPath -Raw) -ne $bootContents) { throw 'Upgrade MSI perdeu preferencia' }
Uninstall-Msi
Write-Output 'PASS: MSI limpo, upgrade 0.5.27, startup, preferencia e desinstalacao'
@"
### Instalador Windows validado
- NSIS e MSI: instalacao limpa e desinstalacao.
- Upgrade de 0.5.27 para $Version, preservando boot.json.
- Versao, manifest e loader conferidos; SHA-256 estavel entre duas instalacoes do mesmo pacote.
- Processo nativo permaneceu ativo com subprocesso WebView2.
- Nao valida voz real, GPU/jogo, nem o clique de auto-update no aplicativo.
"@ | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
