@echo off
rem PlankCrash table on this workstation: chain + keeper + invite gateway.
rem Reached from plank.love through the Cloudflare Tunnel in cloudflared.yml.
set REPO=C:\Users\k1rby\projects\robinwood-plank-mainnet-ready
set TABLE=C:\Users\k1rby\plankcrash-table
netstat -ano | findstr /R /C:":8547 .*LISTENING" >nul || start "plankcrash-anvil" /min "%TABLE%\bin\anvil.exe" --port 8547 --host 127.0.0.1 --chain-id 31337 --accounts 20 --balance 10000 --order fifo --state "%TABLE%\state\anvil-state.json" --state-interval 300 --transaction-block-keeper 6000 --block-time 0.1 --mixed-mining --silent
timeout /t 6 /nobreak >nul
cd /d "%REPO%"
set PLANK_PRACTICE_RPC_URL=http://127.0.0.1:8547
netstat -ano | findstr /R /C:":8765 .*LISTENING" >nul || start "plankcrash-keeper" /min cmd /c node .next\standalone\ops\plankcrash-table\arcade-preview.mjs ^>^> "%TABLE%\logs\preview.log" 2^>^&1
set PLANK_INVITE_RPC_URL=http://127.0.0.1:8547
set PLANK_INVITE_STATE_DIR=%TABLE%\state
set PLANK_INVITE_PORT=8766
set PLANK_INVITE_PUBLIC_ORIGIN=https://plank.love
set PLANK_INVITE_TABLE_PATH=/arcade/table.html
set PLANK_INVITE_JOIN_PATH=/table
netstat -ano | findstr /R /C:":8766 .*LISTENING" >nul || start "plankcrash-gateway" /min cmd /c node .next\standalone\ops\plankcrash-table\invite-gateway.mjs ^>^> "%TABLE%\logs\gateway.log" 2^>^&1
start "plankcrash-tunnel" /min "%TABLE%\bin\cloudflared.exe" --config "%TABLE%\cloudflared.yml" tunnel run
echo Table starting: anvil :8547, keeper :8765, gateway :8766, tunnel -> plank-table.gr0v3.online
