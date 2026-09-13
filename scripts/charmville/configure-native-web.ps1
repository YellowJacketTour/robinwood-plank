$ErrorActionPreference = 'Stop'
$charmRepo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$charmRefs = (Resolve-Path (Join-Path $charmRepo '../charmville-references')).Path
$charmSource = Join-Path $charmRefs 'zquest-classic'
$charmSdk = Join-Path $charmRefs 'tooling/emsdk/upstream/emscripten'
$charmBuildTools = Join-Path $charmRefs 'tooling/native-build-env/Scripts'
$charmCache = Join-Path $charmSdk 'cache/sysroot'
$charmFlags = '-sUSE_FREETYPE=1 -sUSE_SDL=2 -sUSE_SDL_MIXER=2 -pthread -msse2 -msimd128 -mssse3 -fexceptions -profiling-funcs -D_NPASS -O2'
$charmLink = '-pthread -fexceptions -profiling-funcs -sSTACK_SIZE=5MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB -sEXPORTED_RUNTIME_METHODS=cwrap,wasmMemory -sIMPORTED_MEMORY=1 -sFORCE_FILESYSTEM=1 -sASYNCIFY=1 -sFULL_ES2=1 -sSDL2_MIXER_FORMATS=["mid"] -sINITIAL_MEMORY=200MB -sALLOW_MEMORY_GROWTH=1 -sPTHREAD_POOL_SIZE=15 -sEXIT_RUNTIME=1 -sMINIFY_HTML=0 -sENVIRONMENT=web,worker -sASSERTIONS=1 -lidbfs.js -lproxyfs.js -lembind -lwebsocket.js'
& (Join-Path $charmSdk 'emcmake.exe') (Join-Path $charmBuildTools 'cmake.exe') -S $charmSource -B (Join-Path $charmSource 'build_charmville_web') -G Ninja `
 '-DCMAKE_BUILD_TYPE=Debug' '-DALLEGRO_SDL=ON' '-DWANT_OPENAL=OFF' '-DWANT_ALSA=OFF' '-DWANT_ALLOW_SSE=OFF' `
 "-DCMAKE_MAKE_PROGRAM=$(Join-Path $charmBuildTools 'ninja.exe')" `
 "-DFLEX_EXECUTABLE=$(Join-Path $charmRefs 'tooling/winflexbison/win_flex.exe')" `
 "-DBISON_EXECUTABLE=$(Join-Path $charmRefs 'tooling/winflexbison/win_bison.exe')" `
 "-DSDL2_INCLUDE_DIR=$(Join-Path $charmCache 'include')" `
 "-DSDL2_LIBRARY=$(Join-Path $charmCache 'lib/wasm32-emscripten/libSDL2-mt.a')" `
 "-DCMAKE_C_FLAGS=$charmFlags" "-DCMAKE_CXX_FLAGS=$charmFlags" "-DCMAKE_EXE_LINKER_FLAGS=$charmLink"
if ($LASTEXITCODE -ne 0) { throw 'Native web configuration failed' }
# This configures an isolated build only. Upstream web patches and a verified
# baseline runtime are required before any candidate renderer is published.
