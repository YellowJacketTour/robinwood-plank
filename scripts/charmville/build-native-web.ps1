param([ValidateSet('zplayer','web_zplayer')][string]$Target='web_zplayer')
$ErrorActionPreference='Stop'
$charmRepo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$charmRefs=(Resolve-Path (Join-Path $charmRepo '../charmville-references')).Path
$charmSource=Join-Path $charmRefs 'zquest-classic'
$charmTools=Join-Path $charmRefs 'tooling/native-build-env/Scripts'
$charmSdk=Join-Path $charmRefs 'tooling/emsdk/upstream/emscripten'
$charmPreviousPath=$env:PATH
try {
 $env:PATH="$charmSdk;$charmTools;$charmPreviousPath"
 # Fail closed if the web dependency patches have been lost on reconfigure.
 # In particular, unpatched SDL heartbeat double-advances the simulation timer.
 $charmAllegro=Join-Path $charmSource 'build_charmville_web/_deps/allegro5-src'
 $charmAllegroPatch=Join-Path $charmSource 'web/patches/allegro5.patch'
 & git -C $charmAllegro apply --reverse --check --ignore-space-change $charmAllegroPatch 2>$null
 if($LASTEXITCODE -ne 0){
  & git -C $charmAllegro apply --check --ignore-space-change $charmAllegroPatch
  if($LASTEXITCODE -ne 0){throw 'Allegro web patch is partially applied or incompatible; inspect dependency changes before building.'}
  & git -C $charmAllegro apply --ignore-space-change $charmAllegroPatch
  if($LASTEXITCODE -ne 0){throw 'Could not apply Allegro web runtime patch.'}
 }
 & (Join-Path $charmTools 'cmake.exe') --build (Join-Path $charmSource 'build_charmville_web') --target $Target --parallel 6
 if($LASTEXITCODE -ne 0){throw "Native web target $Target failed ($LASTEXITCODE)"}
} finally {$env:PATH=$charmPreviousPath}
