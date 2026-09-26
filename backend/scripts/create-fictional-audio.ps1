$ErrorActionPreference = 'Stop'
# Local fixed fictional fixtures only; no microphone or external speech service.
Add-Type -AssemblyName System.Speech
$phrases = @(
  'My name is Demo Alex.',
  'I have a headache. I would like to describe the pain.',
  'What? I do not understand.',
  'It feels like pressure.',
  'No, that is all. Nothing else to add.',
  'It started this morning.',
  'It is mild, three out of ten.',
  'No, I do not have chest pain.',
  'No, I do not have difficulty breathing.',
  'No, I do not have any other symptoms.',
  'No nausea, dizziness, vision changes, fever, or vomiting.',
  'I do not know.',
  'I do not know. I have no other information to add.'
)
$fixtures = @{}
foreach ($phrase in $phrases) {
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $stream = New-Object System.IO.MemoryStream
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $speaker.SetOutputToAudioStream($stream, $format)
  $speaker.Speak($phrase)
  $speaker.Dispose()
  $fixtures[$phrase] = [Convert]::ToBase64String($stream.ToArray())
  $stream.Dispose()
}
$fixtures | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot '../../.bounded-audio.json')
Write-Output "Created $($phrases.Count) fixed fictional PCM audio fixtures."
