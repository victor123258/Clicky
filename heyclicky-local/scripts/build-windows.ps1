$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3.12 is required to package the backend. Install it from python.org and retry.'
}
if (-not (Test-Path 'node_modules/electron-builder')) {
    throw 'Node dependencies are missing. Run npm ci before building.'
}

python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller

$PyInstallerArgs = @(
    '--noconfirm', '--clean', '--onefile', '--name', 'heyclicky-engine',
    '--distpath', 'dist/backend', '--workpath', 'build/pyinstaller',
    '--collect-all', 'google.genai',
    '--collect-all', 'google.auth',
    '--collect-all', 'speech_recognition',
    '--collect-all', 'pyttsx3',
    '--collect-all', 'comtypes',
    '--collect-all', 'pyautogui',
    '--collect-all', 'keyboard',
    '--collect-all', 'PIL',
    '--hidden-import', 'pyaudio',
    '--hidden-import', 'pyttsx3.drivers.sapi5',
    'engine.py'
)
python -m PyInstaller @PyInstallerArgs
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed.' }
if (-not (Test-Path 'dist/backend/heyclicky-engine.exe')) { throw 'Backend executable was not created.' }

npm run dist:win
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed.' }
Write-Host 'Windows installer created in release/.' -ForegroundColor Green
