@echo off
REM Manual catalog refresh (Shipwreck + Bead Tin) — double-click to run.
REM Pulls fresh prices + stock, writes out\REPORT.md, then shows what would
REM change in Supabase and asks "Apply these changes to Supabase? (y/N)".
REM Nothing is scheduled and nothing is pushed to GitHub.
cd /d "%~dp0"
node refresh.js
echo.
pause
