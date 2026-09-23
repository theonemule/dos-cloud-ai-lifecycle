@echo off
REM DOS Games Archive DOSBox launch script
REM 
REM Game: Commander Keen: Invasion of the Vorticons Shareware 1.31
REM Configuration: standard
REM 
config -set cpu "cycles=auto 6075 98%% limit 23880"
config -set render aspect=true
cd KEEN
loadfix -25
KEEN1.EXE
PAUSE >NUL
loadfix -f
cd..
cls
echo Thank you for playing Commander Keen Shareware!
echo.
echo To play again, type KEEN and press Enter
echo.
echo Your DOS Games Archive http://www.dosgamesarchive.com/
@echo on