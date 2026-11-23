param([string] $Voice = 'Microsoft Heera')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$projectDirectory = Split-Path -Parent $PSScriptRoot
$cuePath = Join-Path $projectDirectory 'src/narration.json'
$cues = Get-Content -LiteralPath $cuePath -Raw | ConvertFrom-Json
$outputDirectory = Join-Path $projectDirectory 'public/narration'
$null = New-Item -ItemType Directory -Path $outputDirectory -Force

$synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $synthesizer.SelectVoice($Voice)
    foreach ($entry in $cues.PSObject.Properties) {
        $cue = $entry.Value
        $synthesizer.Rate = $cue.rate
        $outputPath = Join-Path $outputDirectory $cue.file
        $synthesizer.SetOutputToWaveFile($outputPath)
        try {
            $synthesizer.Speak($cue.text)
        } finally {
            $synthesizer.SetOutputToNull()
        }
        Write-Output "Wrote $($cue.file)"
    }
} finally {
    $synthesizer.Dispose()
}
