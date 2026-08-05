@echo off
setlocal
cd /d "%~dp0"

set "VENV=.venv"
set "PY=%VENV%\Scripts\python.exe"
set "STAMP=%VENV%\.deps-installed"

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH.
  echo         Install Python 3.10+ from https://www.python.org/downloads/
  echo         and tick "Add python.exe to PATH" during setup.
  goto :fail
)

if not exist "%PY%" (
  echo [setup] Creating virtual environment in %VENV% ...
  python -m venv "%VENV%"
  if errorlevel 1 goto :fail
)

if not exist "%STAMP%" (
  echo [setup] Installing dependencies ^(first run only, this takes a minute^) ...
  "%PY%" -m pip install --upgrade pip
  "%PY%" -m pip install -r requirements.txt
  if errorlevel 1 goto :fail
  echo installed> "%STAMP%"
)

where tesseract >nul 2>&1
if errorlevel 1 (
  if not exist "C:\Program Files\Tesseract-OCR\tesseract.exe" (
    echo.
    echo [WARNING] Tesseract OCR was not found. Region OCR will not work.
    echo           Install it with:  winget install UB-Mannheim.TesseractOCR
    echo           Then close and re-run this script.
    echo.
  )
)

echo [run] Starting the app - your browser will open shortly.
echo       Close this window ^(or press Ctrl+C^) to stop the server.
"%PY%" app.py
if errorlevel 1 goto :fail

endlocal
exit /b 0

:fail
echo.
echo [ERROR] Startup failed. See the messages above.
echo         To force a clean reinstall, delete the .venv folder and run again.
pause
exit /b 1
