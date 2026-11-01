@echo off
rem CLI entry. Set MCDL_JAVA to override which Java runs MCDL.
cd /d "%~dp0"
if defined MCDL_JAVA (
  "%MCDL_JAVA%" -jar "mcdl.jar" %*
) else (
  java -jar "mcdl.jar" %*
)