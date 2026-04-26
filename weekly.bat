@echo off
REM Windows Task Scheduler wrapper for the weekly Shipwreck catalog sync.
REM Logs every run to logs\weekly-YYYY-MM-DD.log so failures are diagnosable.
REM On success, commits the new snapshot to GitHub for version-controlled history.

setlocal enabledelayedexpansion

cd /d "%~dp0"

REM Build a date string for the log filename (YYYY-MM-DD)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set _dt=%%I
set _date=%_dt:~0,4%-%_dt:~4,2%-%_dt:~6,2%
set _logdir=%~dp0logs
set _log=%_logdir%\weekly-%_date%.log

if not exist "%_logdir%" mkdir "%_logdir%"

echo === Weekly Shipwreck catalog sync — %_date% === > "%_log%"
echo Started at %date% %time% >> "%_log%"
echo. >> "%_log%"

REM --- Run the orchestrator ---
node weekly.js >> "%_log%" 2>&1
set _rc=%errorlevel%

echo. >> "%_log%"
echo Orchestrator exit code: %_rc% >> "%_log%"

if %_rc% NEQ 0 (
  echo ABORTED: weekly.js exited %_rc% — not committing. >> "%_log%"
  echo See log: %_log%
  exit /b %_rc%
)

REM --- Commit and push the new snapshot ---
echo. >> "%_log%"
echo === Committing snapshot to GitHub === >> "%_log%"
git add out/ snapshots/ >> "%_log%" 2>&1
git diff --cached --quiet
if %errorlevel% EQU 0 (
  echo No changes to commit. >> "%_log%"
) else (
  git commit -m "Weekly catalog sync — %_date%" >> "%_log%" 2>&1
  git push >> "%_log%" 2>&1
  if !errorlevel! NEQ 0 (
    echo WARNING: git push failed. Commit is local-only. >> "%_log%"
  )
)

echo. >> "%_log%"
echo Finished at %date% %time% >> "%_log%"

endlocal
