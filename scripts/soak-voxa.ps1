param(
  [int]$DurationMinutes = 120,
  [int]$SampleSeconds = 5,
  [int]$MaxMemoryGrowthMb = 512,
  [int]$MaxHandleGrowth = 2000,
  [string]$Output = "work/voxa-soak.csv"
)

$ErrorActionPreference = "Stop"
$process = Get-Process -Name voxa -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -Last 1
if (-not $process) { throw "Abra o Voxa, inicie uma transmissão e execute o soak novamente." }

$directory = Split-Path -Parent $Output
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
"timestamp,private_mb,working_set_mb,handles,cpu_seconds" | Set-Content -LiteralPath $Output -Encoding utf8
$process.Refresh()
$baselineMemory = $process.PrivateMemorySize64
$baselineHandles = $process.HandleCount
$deadline = (Get-Date).AddMinutes($DurationMinutes)
$peakMemory = $baselineMemory
$peakHandles = $baselineHandles

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $SampleSeconds
  $process.Refresh()
  if ($process.HasExited) { throw "O Voxa encerrou durante o soak." }
  $peakMemory = [Math]::Max($peakMemory, $process.PrivateMemorySize64)
  $peakHandles = [Math]::Max($peakHandles, $process.HandleCount)
  $row = "{0:o},{1:N2},{2:N2},{3},{4:N2}" -f (Get-Date), ($process.PrivateMemorySize64 / 1MB), ($process.WorkingSet64 / 1MB), $process.HandleCount, $process.TotalProcessorTime.TotalSeconds
  Add-Content -LiteralPath $Output -Value $row -Encoding utf8
}

$memoryGrowth = [Math]::Round(($peakMemory - $baselineMemory) / 1MB, 2)
$handleGrowth = $peakHandles - $baselineHandles
Write-Host "Soak concluído: crescimento máximo ${memoryGrowth} MB e ${handleGrowth} handles. CSV: $Output"
if ($memoryGrowth -gt $MaxMemoryGrowthMb) { throw "Possível vazamento de memória: +${memoryGrowth} MB" }
if ($handleGrowth -gt $MaxHandleGrowth) { throw "Possível vazamento de handles: +${handleGrowth}" }
