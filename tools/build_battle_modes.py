"""Write web/battle-modes.js: every battle mode the client defines - its arena bonus types and GUI types - with the
client's own name of each and a short tag (`abbr`) the replay viewer shows for a battle that is not two teams.

Where the data comes from (all read-only on the client):
- the types: every class named ARENA_BONUS_TYPE or ARENA_GUI_TYPE in the client's bytecode - scripts/common/constants.pyc
  and the extension packages that add their own (comp7, fun_random, halloween, fort_rush, last_stand... in 2.4.1.1) -
  read under the client's own python27.dll (as tools/inspect_hook_names.py does), no game import;
- the names: the client's texts in its language, #menu:bonusType/<bonus type> and #menu:loading/battleTypes/<GUI type>,
  from res/text/lc_messages/menu.mo and every <package>.menu.extend.mo (the extensions' additions to that domain);
  a template ('%(modeName)s'), an empty text or none leaves the name out;
- the battle records Bullba Hits holds (<client>/mods/configs/local.armor_inspector/battles/*.jsonl, their 'mode'): a
  type a record names that this client no longer defines (an ended event, e.g. WHITE_TIGER 110) is added with its
  constant name from the record.

The table is CUMULATIVE (like tools/build_vehicle_modes.py): the existing web/battle-modes.js is read first and every
entry it has is kept - its abbr above all, which is written by hand: a type the client defines with no abbr is listed
loudly at the end ("new modes without an abbreviation"), and the agent rebuilding for a new client fills them in the
table (2-3 uppercase letters, as a player knows the mode, unique among the bonus types). An existing table that cannot be
read stops the tool before anything is written.

Run it after a client update (any Python 3 on the dev machine; the client's python27.dll does the bytecode part):
    python tools/build_battle_modes.py [client folder]
The default folder is C:/Games/World_of_Tanks_NA. Writes web/battle-modes.js.
"""
import ctypes
import gettext
import glob
import io
import json
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, 'web', 'battle-modes.js')
DEFAULT_CLIENT = 'C:/Games/World_of_Tanks_NA'
PYTHON27_HOME = os.path.join(ROOT, 'work', 'game-python27')   # the stdlib.zip the client's python27.dll runs with
TABLE = re.compile(r'var BULLBA_BATTLE_MODES = (\{.*?\n\});', re.S)
KINDS = ('bonus', 'gui')

# Run under the client's python27.dll: {kind: {value: constant}} of every ARENA_BONUS_TYPE / ARENA_GUI_TYPE class body
# (its LOAD_CONST <int> / STORE_NAME <NAME> pairs) in every package's bytecode.
SCAN27 = r'''
import sys, marshal, zipfile, types, os, opcode, json
CLASSES = {'ARENA_BONUS_TYPE': 'bonus', 'ARENA_GUI_TYPE': 'gui'}
def pairs(c):
    b = c.co_code; i = 0; last = None; out = []; ext = 0
    while i < len(b):
        op = ord(b[i])
        if op >= opcode.HAVE_ARGUMENT:
            arg = ord(b[i + 1]) | (ord(b[i + 2]) << 8) | ext; ext = 0; i += 3
            if op == opcode.EXTENDED_ARG: ext = arg << 16; continue
        else:
            arg = None; i += 1
        name = opcode.opname[op]
        if name == 'LOAD_CONST': last = c.co_consts[arg]; continue
        if name == 'STORE_NAME' and type(last) in (int, long) and c.co_names[arg][:1].isupper(): out.append((c.co_names[arg], int(last)))
        last = None
    return out
found = {'bonus': {}, 'gui': {}, 'sources': {}}
def walk(c, where):
    for k in c.co_consts:
        if isinstance(k, types.CodeType):
            kind = CLASSES.get(k.co_name)
            if kind:
                for name, value in pairs(k):
                    found[kind].setdefault(str(value), name)
                    found['sources'].setdefault(kind + ':' + str(value), where)
            walk(k, where)
folder = os.path.join(CLIENT, 'res', 'packages')
for pkg in sorted(os.listdir(folder)):
    if not pkg.endswith('.pkg'): continue
    try: z = zipfile.ZipFile(os.path.join(folder, pkg))
    except Exception: continue
    for n in z.namelist():
        if not n.endswith('.pyc'): continue
        data = z.read(n)
        if 'ARENA_BONUS_TYPE' not in data and 'ARENA_GUI_TYPE' not in data: continue
        try: walk(marshal.loads(data[8:]), pkg + '/' + n)
        except Exception: pass
open(OUT, 'wb').write(json.dumps(found))
'''


def client_types(client):
    """{bonus: {value: constant}, gui: {...}, sources: {...}} from the client's bytecode (SCAN27 under its python27.dll)."""
    dll = os.path.join(client, 'win64', 'python27.dll')
    if not os.path.isfile(os.path.join(PYTHON27_HOME, 'stdlib.zip')):
        raise SystemExit('No %s/stdlib.zip: the client Python stdlib the bytecode is read with' % PYTHON27_HOME)
    out = os.path.join(tempfile.mkdtemp(), 'types.json')
    os.environ.update(PYTHONHOME=PYTHON27_HOME, PYTHONPATH=os.path.join(PYTHON27_HOME, 'stdlib.zip'), PYTHONNOUSERSITE='1')
    runtime = ctypes.PyDLL(dll)
    runtime.Py_Initialize()
    runtime.PyRun_SimpleString.argtypes = [ctypes.c_char_p]
    head = 'import sys\nsys.path[:]=[%r]\nCLIENT=%r\nOUT=%r\n' % (os.path.join(PYTHON27_HOME, 'stdlib.zip'), client, out)
    status = runtime.PyRun_SimpleString((head + SCAN27).encode('ascii'))
    if status or not os.path.isfile(out):
        raise SystemExit('Reading the client bytecode failed (status %s)' % status)
    with io.open(out, encoding='utf-8') as stream:
        return json.load(stream)


def client_texts(client):
    """The menu domain's texts: menu.mo and every <package>.menu.extend.mo, as one catalogue."""
    folder = os.path.join(client, 'res', 'text', 'lc_messages')
    catalogue = {}
    for path in [os.path.join(folder, 'menu.mo')] + sorted(glob.glob(os.path.join(folder, '*.menu.extend.mo'))):
        try:
            with open(path, 'rb') as stream:
                found = gettext.GNUTranslations(stream)._catalog
        except (OSError, IOError, Exception):
            continue
        for key, value in found.items():
            if isinstance(key, str) and isinstance(value, str) and value.strip(): catalogue.setdefault(key, value)
    return catalogue


def name_of(texts, key):
    value = (texts.get(key) or '').strip().strip('"').strip()
    if not value or '%(' in value or '?empty?' in value: return None
    return value


def record_types(client):
    """{kind: {value: constant}} of the types the battle records name (their first line's 'mode')."""
    out = {'bonus': {}, 'gui': {}}
    for path in sorted(glob.glob(os.path.join(client, 'mods', 'configs', 'local.armor_inspector', 'battles', '*.jsonl'))):
        try:
            with io.open(path, encoding='utf-8', errors='replace') as stream:
                mode = (json.loads(stream.readline()) or {}).get('mode') or {}
        except (OSError, ValueError):
            continue
        for kind, value, name in (('bonus', mode.get('bonusType'), mode.get('bonusTypeName')),
                                  ('gui', mode.get('guiType'), mode.get('guiTypeName'))):
            if isinstance(value, int) and isinstance(name, str) and name: out[kind].setdefault(str(value), name)
    return out


def read_table(path):
    if not os.path.exists(path):
        return {}
    with io.open(path, encoding='utf-8') as stream:
        match = TABLE.search(stream.read())
    try:
        table = json.loads(match.group(1)) if match else None
    except ValueError:
        table = None
    if not isinstance(table, dict) or not all(isinstance(table.get(k, {}), dict) for k in KINDS):
        raise SystemExit('Cannot read the existing ' + path + '; not overwriting it (fix or remove it first)')
    return table


def client_version(folder):
    with open(os.path.join(folder, 'version.xml'), 'rb') as stream:
        return (ET.fromstring(stream.read()).findtext('version') or '').strip()


def merge(previous, types, texts, records, version):
    """The new table: the previous entries kept (abbr untouched), the client's types updated (constant, name, client),
    the records' types the client lacks added."""
    table = {'client': version}
    for kind in KINDS:
        rows = dict((k, dict(v)) for k, v in (previous.get(kind) or {}).items() if isinstance(v, dict))
        key = '#menu:bonusType/%s' if kind == 'bonus' else '#menu:loading/battleTypes/%s'
        for value, const in types.get(kind, {}).items():
            row = rows.setdefault(value, {})
            row['const'] = const
            row['client'] = version
            name = name_of(texts, (key % value)[len('#menu:'):])
            if name: row['name'] = name
        for value, const in records.get(kind, {}).items():
            if value in rows: continue
            rows[value] = {'const': const, 'client': 'records'}
        table[kind] = rows
    return table


def write(table):
    def compact(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
    lines = ['// Generated by tools/build_battle_modes.py, last from the installed client ' + table['client'] + '.',
             '// Every battle mode the client defines: bonus types and GUI types (the client\'s ARENA_BONUS_TYPE /',
             '// ARENA_GUI_TYPE), the client\'s own name of each and, for a bonus type, the short tag (abbr) the replay',
             '// viewer shows for a battle that is not two teams. Cumulative; abbr is filled by hand when a client adds a mode.',
             'var BULLBA_BATTLE_MODES = {', '"client":' + compact(table['client']) + ',']
    for i, kind in enumerate(KINDS):
        rows = table[kind]
        lines.append(compact(kind) + ':{')
        lines.append(',\n'.join(' ' + compact(k) + ':' + compact(rows[k]) for k in sorted(rows, key=int)))
        lines.append('}' + (',' if i + 1 < len(KINDS) else ''))
    lines += ['};', "if (typeof window !== 'undefined') window.BULLBA_BATTLE_MODES = BULLBA_BATTLE_MODES;",
              "if (typeof module !== 'undefined' && module.exports) module.exports = BULLBA_BATTLE_MODES;", '']
    text = u'\n'.join(lines)
    with io.open(TARGET, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(text)


def main():
    client = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CLIENT
    previous = read_table(TARGET)
    version = client_version(client)
    types = client_types(client)
    if not types.get('bonus'):
        raise SystemExit('No ARENA_BONUS_TYPE found in the client under ' + client)
    table = merge(previous, types, client_texts(client), record_types(client), version)
    write(table)
    missing = sorted((v for v, row in table['bonus'].items() if not row.get('abbr')), key=int)
    abbrs = [row['abbr'] for row in table['bonus'].values() if row.get('abbr')]
    twice = sorted(set(a for a in abbrs if abbrs.count(a) > 1))
    print('web/battle-modes.js: %d bonus types, %d GUI types (client %s defines %d / %d)' % (
        len(table['bonus']), len(table['gui']), version, len(types['bonus']), len(types.get('gui', {}))))
    if missing:
        print('NEW MODES WITHOUT AN ABBREVIATION: ' + ', '.join('%s %s' % (v, table['bonus'][v].get('const')) for v in missing))
        print('  fill "abbr" for them in web/battle-modes.js (2-3 uppercase letters, unique), then run the checks')
    if twice:
        print('ABBREVIATIONS USED TWICE: ' + ', '.join(twice))
    return 1 if missing or twice else 0


if __name__ == '__main__':
    sys.exit(main())
