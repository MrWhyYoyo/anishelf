@echo off
rem Double-click to start AniShelf. First run sets everything up automatically.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo First run: setting up AniShelf...
    python -m venv .venv || goto :error
    ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :error
)
".venv\Scripts\python.exe" run.py %*
goto :eof

:error
echo.
echo Setup failed. Make sure Python 3 is installed and try again.
pause
