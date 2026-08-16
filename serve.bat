@echo off
REM ---------------------------------------------------------------
REM  Standalone static web server. Self-contained: no project files,
REM  no npm install, no Sandscape. Drop this .bat in any folder and
REM  it serves that folder over http. Does NOT open a browser.
REM
REM    serve.bat            -> http://localhost:8787/
REM    serve.bat 8080       -> http://localhost:8080/
REM
REM  Default is 8787 on purpose: 5173 is where the Sandscape dev
REM  server (WSL) lives, so that port would show Sandscape instead.
REM
REM  Ctrl+C to stop. Only requirement: Node.js on PATH.
REM ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"

where node >nul 2>nul
if errorlevel 1 (
  echo [serve] Node.js not found on PATH. Install Node 18+ and re-run.
  exit /b 1
)

REM Unpack the server source stored at the bottom of this file.
REM Fixed name, rewritten each run, so Ctrl+C never leaves temp files behind.
set "SRV=%TEMP%\_serve_static.mjs"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = (Get-Content -LiteralPath '%~f0' -Raw) -split ('::PAY' + 'LOAD::'), 2;" ^
  "Set-Content -LiteralPath $env:SRV -Value $p[1] -Encoding ASCII"
if not exist "%SRV%" (
  echo [serve] Could not unpack the server source.
  exit /b 1
)

node "%SRV%" %PORT% "%CD%"
set "RC=%ERRORLEVEL%"
del "%SRV%" >nul 2>nul
endlocal & exit /b %RC%

::PAYLOAD::
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2]) || 8787;
const ROOT = path.resolve(process.argv[3] || process.cwd());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.hdr': 'image/vnd.radiance',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400).end('400 - bad request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('403 - forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
         .end('404 - not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => {
  console.log('');
  console.log('  serving : ' + ROOT);
  console.log('  open    : http://localhost:' + PORT + '/');
  console.log('  stop    : Ctrl+C');
  console.log('');
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('[serve] Port ' + PORT + ' is already in use. Try: serve.bat ' + (PORT + 1));
  } else {
    console.error('[serve] ' + e.message);
  }
  process.exit(1);
});
