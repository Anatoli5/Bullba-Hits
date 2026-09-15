"""Refresh the local preview of the page: preview/Viewer.html next to a copy of web/ and the game's data folder.

The user opens C:/Projects/Bullba-Hits/preview/Viewer.html in a browser to try page changes before a build is
made and installed. The data folder is a junction to the installed mod's data (read only by the page), so the
preview always shows the current battles, models and vehicles; nothing is written into the game folder.

    runtime/python.exe tools/preview.py
"""
import io
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
PREVIEW = os.path.join(ROOT, 'preview')
GAME_DATA = r'C:\Games\World_of_Tanks_NA\mods\configs\local.armor_inspector\data'


def copy_web():
    target = os.path.join(PREVIEW, 'web')
    if os.path.isdir(target):
        shutil.rmtree(target)
    shutil.copytree(WEB, target)


def write_page():
    stamp = str(int(time.time()))
    with io.open(os.path.join(WEB, 'index.html'), encoding='utf-8', newline='') as stream:
        html = stream.read()
    # Cache-busting stamps on the local scripts and stylesheets: browsers keep old JS across refreshes otherwise.
    html = re.sub(r'(src="web/[^"]+)"', r'\1?s=' + stamp + '"', html)
    html = re.sub(r'(href="web/[^"]+)"', r'\1?s=' + stamp + '"', html)
    with io.open(os.path.join(PREVIEW, 'Viewer.html'), 'w', encoding='utf-8', newline='') as stream:
        stream.write(html)


def link_data():
    target = os.path.join(PREVIEW, 'data')
    if os.path.isdir(target):
        return 'data: present'
    if not os.path.isdir(GAME_DATA):
        return 'data: game folder not found, no data linked'
    result = subprocess.run(['cmd', '/c', 'mklink', '/J', target, GAME_DATA], capture_output=True, text=True)
    if result.returncode:
        shutil.copytree(GAME_DATA, target)
        return 'data: copied (junction failed: %s)' % result.stderr.strip()
    return 'data: junction to the installed mod'


def main():
    if not os.path.isdir(PREVIEW):
        os.makedirs(PREVIEW)
    copy_web()
    write_page()
    print(link_data())
    print('open: ' + os.path.join(PREVIEW, 'Viewer.html'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
