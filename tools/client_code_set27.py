# -*- coding: utf-8 -*-
"""The inner script of tools/client_code_set.py: run on the offline stand (tests/fixtures-local/ttx-offline, the client's
python27.dll and its items.vehicles over the client's packages, read-only) under its run27.py:

    python tests/fixtures-local/ttx-offline/run27.py tools/client_code_set27.py OUT.json

It builds the characteristics (exporter.ttx_block) and the vehicle file (export_vehicle; models and file writes stubbed) of
every type of the client and records:
  - the client's code they EXECUTE (the C profiler _lsprof, the files of the code objects called) and the modules whose
    objects - a module, a function, a class, a table its own top level defines - that code names (BACKLOG 55: the code set);
  - every client file the client's code opens while items loads and during the builds (the stand's ResMgr shim);
  - the text domains the builds ask translations from;
  - a hash of each type's characteristics and vehicle file as the stand builds them (no value of them).
Names and hashes only: no byte of the client goes into the output.
"""
import sys, os, time, json, traceback, base64, types, dis, marshal, zipfile
OUT = sys.argv[1]
REPO = os.environ.get('BULLBA_REPO') or 'C:/Projects/Bullba-Hits'
STAND = os.path.join(REPO, 'tests', 'fixtures-local', 'ttx-offline').replace(chr(92), '/') + '/'
log = open(OUT + '.log', 'w')
sys.stdout = sys.stderr = log
execfile(STAND + 'boot27.py')
opened = {'boot': set()}
phase = ['boot']
real_open = ResMgr.__class__.openSection


def logged_open(self, path, createIfMissing=False):
    p = str(path).replace(chr(92), '/').lstrip('/')
    while '//' in p: p = p.replace('//', '/')
    i = p.lower().find('.xml/')
    if i >= 0: p = p[:i + 4]
    opened.setdefault(phase[0], set()).add(p)
    return real_open(self, path, createIfMissing)


ResMgr.__class__.openSection = logged_open


def pyc_path(path):
    """A loaded module's file or a code object's file as the client's scripts.pkg names it ('scripts/...pyc')."""
    path = (path or '').replace(chr(92), '/')
    if '.pkg/' in path: path = path.split('.pkg/', 1)[1]
    elif 'stdlib.zip/' in path: path = 'scripts/common/Lib/' + path.split('stdlib.zip/', 1)[1]
    if not path.startswith('scripts/'): return None
    return path[:-3] + '.pyc' if path.endswith('.py') else path


out = {}
try:
    vehicles = boot()
    import frameworks.wulf as wulf
    domains = set()
    real_text = wulf.getTranslatedText

    def text(key, args=None):
        k = key.decode('utf-8', 'replace') if isinstance(key, str) else key
        if phase[0] != 'boot' and k and k[:1] == u'#' and u':' in k: domains.add(k[1:].split(u':', 1)[0])
        return real_text(key, args)
    wulf.getTranslatedText = text
    sys.path.insert(0, os.path.join(REPO, 'mod'))
    from local_armor_inspector import exporter
    import nations, _lsprof
    types_ = sorted(str(item.name) for nid in range(len(nations.NAMES)) for item in (vehicles.g_list.getList(nid) or {}).values())
    exporter.Exporter.publish_vehicle_parts = lambda self, *a, **k: None
    import hashlib
    hashes = {}

    def digest(value, volatile):
        plain = dict((k, v) for k, v in value.items() if k not in volatile)
        return hashlib.sha1(json.dumps(plain, sort_keys=True, default=repr).encode('utf-8')).hexdigest()[:16]

    def capture(path, key, value):
        # The vehicle file the build would write: its hash (BACKLOG 55, second review C2: the stand against the stand).
        # (hashed after the profiler is off: the hashing's own code is no build's)
        if str(key).startswith('vehicle:'): built.setdefault(current_type[0], [None, None])[1] = value
        return 0
    built = {}
    exporter.write_data = capture
    current_type = [None]
    exporter.part_resource = lambda component: 'vehicles/x/collision_client/Hull.model'
    ex = exporter.Exporter(GAME, OUT + '.folder', 'offline\n')
    ex.client_state = False
    profiler = _lsprof.Profiler(builtins=False)
    errors = []
    started = time.time()
    for type_name in types_:
        for kind in ('ttx', 'vehicle'):
            phase[0] = '%s:%s' % (kind, type_name)
            profiler.enable()
            try:
                if kind == 'ttx':
                    current_type[0] = type_name
                    built.setdefault(type_name, [None, None])[0] = exporter.ttx_block(type_name, 'offline', log=False)
                else:
                    current_type[0] = type_name
                    descr = exporter.top_descriptor(type_name)
                    request = {'vehicleType': type_name, 'source': 'catalogue',
                               'compactDescriptor': base64.b64encode(descr.makeCompactDescr()).decode('ascii')}
                    ex.vehicles.pop(exporter.vehicle_id(type_name), None)
                    ex.export_vehicle(request, replay=True, descr=descr)
                    del ex.jobs[:]
                    ex.job_index.clear()
            except Exception as error:
                errors.append('%s %r' % (phase[0], error))
            finally:
                profiler.disable()
    out['buildSeconds'] = round(time.time() - started, 1)
    codes = [entry.code for entry in profiler.getstats() if not isinstance(entry.code, str)]
    executed = set(p for p in (pyc_path(c.co_filename) for c in codes) if p)
    # the module of a code object's file: the loaded module whose own functions or classes come from that file
    module_of = {}
    for name, mod in list(sys.modules.items()):
        if mod is None or not hasattr(mod, '__dict__'): continue
        for value in vars(mod).values():
            for fn in (value, getattr(value, '__init__', None)):
                code = getattr(fn, 'func_code', None) or getattr(getattr(fn, 'im_func', None), 'func_code', None)
                if code is not None and getattr(value, '__module__', None) == name:
                    module_of.setdefault(code.co_filename, name)
    pkg = zipfile.ZipFile(GAME + '/res/packages/scripts.pkg')

    def defined(mod):
        """The names a module's own top level binds (not by an import)."""
        path = pyc_path(getattr(mod, '__file__', None))
        try: top = marshal.loads(pkg.read(path)[8:])
        except Exception: return set()
        seq, ops, i = [], top.co_code, 0
        while i < len(ops):
            op = ord(ops[i]); arg = ord(ops[i + 1]) | (ord(ops[i + 2]) << 8) if op >= dis.HAVE_ARGUMENT else None
            seq.append((dis.opname[op], arg)); i += 3 if op >= dis.HAVE_ARGUMENT else 1
        found = set()
        for k, (op, arg) in enumerate(seq):
            if op not in ('STORE_NAME', 'STORE_GLOBAL'): continue
            j = k - 1
            while j >= 0 and seq[j][0] == 'LOAD_ATTR': j -= 1
            if not (j >= 0 and seq[j][0] in ('IMPORT_FROM', 'IMPORT_NAME')): found.add(top.co_names[arg])
        return found
    origin = {}
    for name, mod in list(sys.modules.items()):
        if mod is None or not pyc_path(getattr(mod, '__file__', None)): continue
        for key in defined(mod):
            obj = getattr(mod, key, None)
            if obj is None or isinstance(obj, (int, long, float, bool, str, unicode)): continue
            origin.setdefault(id(obj), name)
    referenced, unmapped = set(), set()
    for code in codes:
        name = module_of.get(code.co_filename)
        mod = sys.modules.get(name) if name else None
        if mod is None:
            if pyc_path(code.co_filename): unmapped.add(pyc_path(code.co_filename))
            continue
        g = vars(mod)
        for ref in code.co_names:
            obj = g.get(ref)
            if obj is None: continue
            if isinstance(obj, types.ModuleType): src = obj.__name__
            elif isinstance(obj, (types.FunctionType, type, types.ClassType)): src = getattr(obj, '__module__', None)
            else: src = origin.get(id(obj))
            path = pyc_path(getattr(sys.modules.get(src), '__file__', None)) if src else None
            if path: referenced.add(path)
    for type_name, (ttx, vehicle) in built.items():
        hashes[type_name] = [digest(ttx, ('clientVersion', 'producedAt', 'buildMs')) if ttx else None,
                             digest(vehicle, ('exportedAt', 'clientVersion')) if vehicle else None]
    out['outputs'] = hashes
    out.update({'types': len(types_), 'errors': errors, 'executed': sorted(executed), 'referenced': sorted(referenced - executed),
                'unmappedFiles': sorted(unmapped)})
    out['openedBoot'] = sorted(opened.get('boot', ()))
    out['openedBuild'] = sorted(set().union(*[v for k, v in opened.items() if k != 'boot']))
    out['domains'] = sorted(domains)
    with open(GAME + '/version.xml', 'rb') as stream: out['versionXml'] = stream.read(16384).decode('utf-8', 'replace')
except Exception:
    out['crash'] = traceback.format_exc()
with open(OUT, 'w') as stream: stream.write(json.dumps(out, indent=1))
log.close()
