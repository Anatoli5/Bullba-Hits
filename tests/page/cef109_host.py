# Minimal host for the game's own CEF (libcef.dll 109.1.18 / Chromium 109.0.5414.120) through the C API with ctypes.
# stack-env research, 28.09.2026 - NOT part of the product, not wired into tools/check.py.
#
#   python tests/page/cef109_host.py <url> <chromium switches...>
#
# Needs a COPY of the client's CEF runtime in a folder (default: env CEF109_DIR): from <game>/win64 libcef.dll,
# chrome_elf.dll, libEGL.dll, libGLESv2.dll, icudtl.dat, snapshot_blob.bin, v8_context_snapshot.bin, cef_subprocess.exe;
# from <game>/res/cef the *.pak files and locales/. Never run it against the game folder itself (the game folder is
# read-only for us; CEF writes logs and caches next to the switches given).
# Opens one WINDOWED browser (the game uses off-screen rendering; feature support is the same, frame pacing is not).
# All switches come from this process's command line (CEF reads it), e.g. the game's own set:
#   --in-process-gpu --disable-gpu --disable-gpu-compositing --enable-begin-frame-scheduling
#   --disable-site-isolation-trials --disable-features=IsolateOrigins,site-per-process
#   --user-agent="Chrome/109.0.5414.120 WorldOfTanks/2.4.0.0 (en)"
# plus --no-sandbox --browser-subprocess-path=<copy>/cef_subprocess.exe --remote-debugging-port=N --user-data-dir=<tmp>.
# cef_settings_t / cef_browser_settings_t are passed zeroed with only `size` set (found by trying sizes: 440 and 288
# for this build), so every setting stays at its default and the command line decides.
import ctypes, os, sys
from ctypes import c_int, c_void_p, c_size_t, c_wchar_p, c_uint32, Structure, POINTER, byref

CEF = os.environ.get('CEF109_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cef109')
os.add_dll_directory(CEF); os.chdir(CEF)
L = ctypes.CDLL(os.path.join(CEF, 'libcef.dll'))

class cef_string_t(Structure): _fields_ = [('str', c_wchar_p), ('length', c_size_t), ('dtor', c_void_p)]
def cs(s): return cef_string_t(s, len(s), None)
class main_args(Structure): _fields_ = [('instance', c_void_p)]
class rect(Structure): _fields_ = [('x', c_int), ('y', c_int), ('w', c_int), ('h', c_int)]
class window_info(Structure):  # cef_window_info_t, Windows, CEF 109
    _fields_ = [('ex_style', c_uint32), ('window_name', cef_string_t), ('style', c_uint32), ('bounds', rect), ('parent', c_void_p),
                ('menu', c_void_p), ('windowless', c_int), ('shared_texture', c_int), ('external_begin_frame', c_int), ('window', c_void_p)]

args = main_args(ctypes.windll.kernel32.GetModuleHandleW(None))
L.cef_execute_process.argtypes = [POINTER(main_args), c_void_p, c_void_p]
code = L.cef_execute_process(byref(args), None, None)
if code >= 0: sys.exit(code)

def sized(size):
    buf = (ctypes.c_ubyte * 2048)(); c_size_t.from_buffer(buf, 0).value = size; return buf

L.cef_initialize.argtypes = [POINTER(main_args), c_void_p, c_void_p, c_void_p]
for size in [440] + list(range(64, 1024, 8)):
    settings = sized(size); c_int.from_buffer(settings, 8).value = 1  # no_sandbox
    if L.cef_initialize(byref(args), settings, None, None): print('cef_initialize ok, cef_settings_t size', size, flush=True); break
else: print('cef_initialize failed', flush=True); sys.exit(1)

url = next((a for a in sys.argv[1:] if not a.startswith('--')), 'about:blank')
wi = window_info(); wi.style = 0x00CF0000 | 0x02000000 | 0x04000000 | 0x10000000; wi.bounds = rect(40, 40, 900, 700); wi.window_name = cs('cef109 probe')
L.cef_browser_host_create_browser.argtypes = [POINTER(window_info), c_void_p, POINTER(cef_string_t), c_void_p, c_void_p, c_void_p]
u = cs(url)
for size in [288] + list(range(16, 1024, 8)):
    if L.cef_browser_host_create_browser(byref(wi), None, byref(u), sized(size), None, None): print('create_browser ok, cef_browser_settings_t size', size, flush=True); break
else: print('create_browser failed', flush=True); sys.exit(1)
L.cef_run_message_loop()  # the caller kills the process tree when done
