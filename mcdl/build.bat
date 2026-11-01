@echo off
rem Build MCDL: outputs build\classes and mcdl.jar
setlocal
set ROOT=%~dp0
if exist "%ROOT%build\classes" rmdir /s /q "%ROOT%build\classes"
mkdir "%ROOT%build\classes" 2>nul
set LIST=%TEMP%\mcdl_sources.txt
if exist "%LIST%" del "%LIST%" 2>nul
dir /s /b "%ROOT%src\*.java" > "%LIST%"
javac -encoding UTF-8 --release 17 -d "%ROOT%build\classes" @"%LIST%"
if errorlevel 1 (
  echo BUILD FAILED: javac error
  exit /b 1
)
jar --create --file "%ROOT%mcdl.jar" --main-class mcdl.Main -C "%ROOT%build\classes" .
if errorlevel 1 (
  echo BUILD FAILED: jar error
  exit /b 1
)
echo BUILD OK: %ROOT%mcdl.jar

rem Native dialog helper (IFileOpenDialog). Build once, ship with the app.
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if exist "%CSC%" (
  "%CSC%" /nologo /target:winexe /out:"%ROOT%McdlDialog.exe" "%ROOT%native\McdlDialog.cs"
  if errorlevel 1 (
    echo BUILD FAILED: csc error
    exit /b 1
  )
  echo BUILD OK: %ROOT%McdlDialog.exe
) else (
  echo WARNING: csc.exe not found, skip McdlDialog.exe
)