@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\install.js" (
	call npm install
	if errorlevel 1 exit /b %errorlevel%
)

if not exist "node_modules\electron\dist\electron.exe" (
	node "node_modules\electron\install.js"
	if errorlevel 1 exit /b %errorlevel%
)

call npm start
