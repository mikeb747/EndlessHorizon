/**
 * Builds a self-contained, zero-npm-install 1-click local launcher bundle in `release-local/`.
 * Includes:
 *   - dist/ (production Vite + PWA frontend)
 *   - server.mjs (bundled Express + dotenv + Strava upload proxy, zero node_modules needed)
 *   - Start Endless Horizon Cycling.bat / .command (starts localhost:3000 & opens Chrome/Edge)
 *   - Configure Strava.bat / .command (local-only interactive setup saving to ~/.endless-horizon-cycling.env)
 *   - .env.example & README.txt
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'release-local');

if (!fs.existsSync(distDir)) {
  console.error('Error: dist/ does not exist. Run "npm run build" before building the local bundle.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1) Copy built frontend into release-local/dist
fs.cpSync(distDir, path.join(outDir, 'dist'), { recursive: true });

// 2) Copy .env.example template (never copies any real .env file!)
const envExampleSrc = path.join(rootDir, '.env.example');
if (fs.existsSync(envExampleSrc)) {
  fs.copyFileSync(envExampleSrc, path.join(outDir, '.env.example'));
}

// 3) Bundle server.ts into a single standalone ESM file with zero runtime npm dependencies
await build({
  entryPoints: [path.join(rootDir, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(outDir, 'server.mjs'),
  external: ['vite'],
  banner: {
    js: "import { createRequire as __ehcCreateRequire } from 'node:module'; const require = __ehcCreateRequire(import.meta.url);",
  },
  minify: false,
  sourcemap: false,
});

// 4) Windows 1-click launcher (.bat with CRLF line endings)
const windowsStartBat = [
  '@echo off',
  'setlocal',
  'title Endless Horizon Cycling (Local Server)',
  'cd /d "%~dp0"',
  '',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo.',
  '  echo ================================================================',
  '  echo   Node.js is required to run the local Endless Horizon server.',
  '  echo   Download Node.js LTS from: https://nodejs.org',
  '  echo ================================================================',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'set "NODE_ENV=production"',
  'set "PORT=3000"',
  'set "URL=http://localhost:%PORT%"',
  '',
  'echo.',
  'echo ================================================================',
  'echo   Endless Horizon Cycling - Local Server + Strava Upload Ready',
  'echo   URL: %URL%',
  'echo   Keep this window open while riding.',
  'echo   Close this window or press Ctrl+C to stop the server.',
  'echo ================================================================',
  'echo.',
  '',
  'rem If the server is already running on port 3000, just open the browser',
  `powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul`,
  'if not errorlevel 1 (',
  '  echo Server is already running on %URL%. Opening browser...',
  '  call :open_browser',
  '  exit /b 0',
  ')',
  '',
  'rem Open Chrome or Edge (for Web Bluetooth) once the local server is listening',
  `start "" /b powershell -NoProfile -Command "$u='http://localhost:3000'; for ($i=0; $i -lt 30; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri ($u + '/api/health') -TimeoutSec 1; if ($r.StatusCode -eq 200) { break } } catch { Start-Sleep -Milliseconds 300 } }; $chrome = @(Join-Path $env:ProgramFiles 'Google\\Chrome\\Application\\chrome.exe'; Join-Path \${env:ProgramFiles(x86)} 'Google\\Chrome\\Application\\chrome.exe'; Join-Path $env:LocalAppData 'Google\\Chrome\\Application\\chrome.exe') | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1; $edge = @(Join-Path \${env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe'; Join-Path $env:ProgramFiles 'Microsoft\\Edge\\Application\\msedge.exe') | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1; if ($chrome) { Start-Process $chrome $u } elseif ($edge) { Start-Process $edge $u } else { Start-Process $u }"`,
  '',
  'node server.mjs',
  'echo.',
  'echo Server stopped.',
  'pause',
  'exit /b 0',
  '',
  ':open_browser',
  `powershell -NoProfile -Command "$u='http://localhost:3000'; $chrome = @(Join-Path $env:ProgramFiles 'Google\\Chrome\\Application\\chrome.exe'; Join-Path \${env:ProgramFiles(x86)} 'Google\\Chrome\\Application\\chrome.exe'; Join-Path $env:LocalAppData 'Google\\Chrome\\Application\\chrome.exe') | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1; $edge = @(Join-Path \${env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe'; Join-Path $env:ProgramFiles 'Microsoft\\Edge\\Application\\msedge.exe') | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1; if ($chrome) { Start-Process $chrome $u } elseif ($edge) { Start-Process $edge $u } else { Start-Process $u }"`,
  'exit /b 0',
  '',
].join('\r\n');

fs.writeFileSync(path.join(outDir, 'Start Endless Horizon Cycling.bat'), windowsStartBat, 'utf8');

// 5) Windows 1-click Strava credentials configurator (saves strictly locally to %USERPROFILE%\.endless-horizon-cycling.env)
const windowsConfigStravaBat = [
  '@echo off',
  'setlocal',
  'title Configure Strava - Endless Horizon Cycling',
  'echo.',
  'echo ================================================================',
  'echo   Endless Horizon Cycling - Local Strava Setup',
  'echo   Credentials are saved ONLY to your private user profile:',
  'echo   %USERPROFILE%\\.endless-horizon-cycling.env',
  'echo   (They stay preserved even when you download newer builds!)',
  'echo ================================================================',
  'echo.',
  'echo Leave any field blank and press Enter to skip it.',
  'echo.',
  'set /p "STRAVA_CLIENT_ID=Strava Client ID (optional if using Access Token): "',
  'set /p "STRAVA_CLIENT_SECRET=Strava Client Secret: "',
  'set /p "STRAVA_ACCESS_TOKEN=Strava Access Token: "',
  'set /p "STRAVA_REFRESH_TOKEN=Strava Refresh Token: "',
  '',
  'set "CFG=%USERPROFILE%\\.endless-horizon-cycling.env"',
  '(',
  '  echo # Endless Horizon Cycling - Private Local Strava Config',
  '  echo STRAVA_CLIENT_ID=%STRAVA_CLIENT_ID%',
  '  echo STRAVA_CLIENT_SECRET=%STRAVA_CLIENT_SECRET%',
  '  echo STRAVA_ACCESS_TOKEN=%STRAVA_ACCESS_TOKEN%',
  '  echo STRAVA_REFRESH_TOKEN=%STRAVA_REFRESH_TOKEN%',
  ') > "%CFG%"',
  '',
  'echo.',
  'echo Saved Strava configuration to: %CFG%',
  'echo Restart "Start Endless Horizon Cycling.bat" if it is already running.',
  'echo.',
  'pause',
  '',
].join('\r\n');

fs.writeFileSync(path.join(outDir, 'Configure Strava.bat'), windowsConfigStravaBat, 'utf8');

// 6) macOS / Linux 1-click launcher (.command)
const unixStartCommand = [
  '#!/usr/bin/env bash',
  'set -e',
  'cd "$(dirname "$0")"',
  '',
  'if ! command -v node >/dev/null 2>&1; then',
  '  echo "Node.js is required. Download Node.js LTS from https://nodejs.org"',
  '  exit 1',
  'fi',
  '',
  'export NODE_ENV=production',
  'export PORT=3000',
  'URL="http://localhost:${PORT}"',
  '',
  'echo "================================================================"',
  'echo "  Endless Horizon Cycling - Local Server + Strava Upload Ready"',
  'echo "  URL: ${URL}"',
  'echo "  Press Ctrl+C or close this terminal window to stop."',
  'echo "================================================================"',
  '',
  '(sleep 1.2 && (open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true)) &',
  'exec node server.mjs',
  '',
].join('\n');

const unixStartPath = path.join(outDir, 'Start Endless Horizon Cycling.command');
fs.writeFileSync(unixStartPath, unixStartCommand, 'utf8');
fs.chmodSync(unixStartPath, 0o755);

// 7) macOS / Linux Strava configurator (.command)
const unixConfigStrava = [
  '#!/usr/bin/env bash',
  'set -e',
  'CFG="$HOME/.endless-horizon-cycling.env"',
  'echo "Endless Horizon Cycling - Local Strava Setup"',
  'echo "Credentials will be saved ONLY to: $CFG"',
  'echo ""',
  'read -r -p "Strava Client ID (optional if using Access Token): " STRAVA_CLIENT_ID',
  'read -r -p "Strava Client Secret: " STRAVA_CLIENT_SECRET',
  'read -r -p "Strava Access Token: " STRAVA_ACCESS_TOKEN',
  'read -r -p "Strava Refresh Token: " STRAVA_REFRESH_TOKEN',
  '',
  'cat > "$CFG" <<EOF',
  '# Endless Horizon Cycling - Private Local Strava Config',
  'STRAVA_CLIENT_ID=${STRAVA_CLIENT_ID}',
  'STRAVA_CLIENT_SECRET=${STRAVA_CLIENT_SECRET}',
  'STRAVA_ACCESS_TOKEN=${STRAVA_ACCESS_TOKEN}',
  'STRAVA_REFRESH_TOKEN=${STRAVA_REFRESH_TOKEN}',
  'EOF',
  'chmod 600 "$CFG"',
  'echo ""',
  'echo "Saved to $CFG. Restart Start Endless Horizon Cycling.command if it is already running."',
  '',
].join('\n');

const unixConfigPath = path.join(outDir, 'Configure Strava.command');
fs.writeFileSync(unixConfigPath, unixConfigStrava, 'utf8');
fs.chmodSync(unixConfigPath, 0o755);

// 8) Quick-start README.txt
const readmeTxt = [
  'ENDLESS HORIZON CYCLING - 1-CLICK LOCAL EDITION',
  '===============================================',
  '',
  'Requirements: Node.js 22+ installed (https://nodejs.org). No npm install needed!',
  '',
  'WINDOWS:',
  '  1. (First time only, for Strava uploads) Double-click "Configure Strava.bat"',
  '     and paste your Strava credentials. They are saved privately to your Windows',
  '     user profile (%USERPROFILE%\\.endless-horizon-cycling.env) so future updates',
  '     automatically remember them.',
  '  2. Double-click "Start Endless Horizon Cycling.bat".',
  '     It starts the local server on http://localhost:3000 and opens Chrome/Edge',
  '     with Web Bluetooth and direct 1-click Strava upload ready.',
  '  3. Close the terminal window (or press Ctrl+C) when finished riding.',
  '',
  'MAC / LINUX:',
  '  1. Run "Configure Strava.command" once to save your Strava keys locally.',
  '  2. Run "Start Endless Horizon Cycling.command".',
  '',
].join('\r\n');

fs.writeFileSync(path.join(outDir, 'README.txt'), readmeTxt, 'utf8');

const serverBytes = fs.statSync(path.join(outDir, 'server.mjs')).size;
console.log(
  `Built 1-click local bundle in release-local/ (server.mjs: ${(serverBytes / 1024).toFixed(1)} KB)`
);
