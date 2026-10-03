# -*- coding: utf-8 -*-
"""What the client's code set takes from modules outside it (BACKLOG 55, second review of 02.10).

The characteristics and the vehicle files are keyed by the code their builds execute: the modules of client_code.CODE_MODULES,
each by its whole code (exporter.code_identity). Those modules also take names from modules outside the set - a scalar
(realm.CURRENT_REALM, tankmen.MAX_SKILL_LEVEL), a function or class, an object built at import (a cache, a hit tester). Pulling
those modules in whole would pull in the crew's tables that 2.4.0.2 changed and rebuild everything again; so only the names
the set takes are keyed, each by what defines it:

  - read from the set modules' bytecode: `from X import n` (n of X) and `import X` ... `X.n` (n of X), X outside the set;
  - the identity of n in X: the top-level statements of X that bind n (by assignment, def, class or import) and those that
    change what n names (X.n.update(...), n[k] = v), as bytecode with its constants (a function or class body by its code's
    identity) and jump targets relative to the statement - not line numbers, not the file; each name such a statement loads is
    followed in its own module, two levels deep (an object built at import: its class, and what built it).
No byte of the client is kept: only identities (sha1). Python 2 bytecode (the client's); anything that does not decode is the
module's bytes ('bytes:<crc>'), so it changes with the file.
"""
from __future__ import absolute_import
import dis
import hashlib
import marshal

STORE = ('STORE_NAME', 'STORE_GLOBAL')
END = STORE + ('STORE_ATTR', 'STORE_SUBSCR', 'POP_TOP', 'DELETE_NAME', 'DELETE_GLOBAL', 'DELETE_SUBSCR', 'DELETE_ATTR')
NAMES = ('LOAD_NAME', 'LOAD_GLOBAL', 'STORE_NAME', 'STORE_GLOBAL', 'LOAD_ATTR', 'STORE_ATTR', 'IMPORT_NAME', 'IMPORT_FROM',
         'DELETE_NAME', 'DELETE_GLOBAL', 'DELETE_ATTR')
DEPTH = 2


def instructions(code):
    """[(offset, opname, arg)] of a Python 2 code object."""
    ops, found, i, extended = code.co_code, [], 0, 0
    at = (lambda k: ord(ops[k])) if isinstance(ops, str) else (lambda k: ops[k])
    while i < len(ops):
        op, start = at(i), i
        if op >= dis.HAVE_ARGUMENT:
            arg = at(i + 1) | (at(i + 2) << 8) | extended
            extended = 0
            i += 3
            if dis.opname[op] == 'EXTENDED_ARG':
                extended = arg << 16
                continue
        else:
            arg, i = None, i + 1
        found.append((start, dis.opname[op], arg))
    return found


class Module(object):
    """One client module's top level, by the names it binds."""

    def __init__(self, path, code, identity_of_code):
        self.path = path
        self.code = code
        self.bindings = {}    # name -> [(kind, ...)]; kinds: ('import', module, level, attr), ('module', module, level), ('value', text, loads)
        self.touches = {}     # name -> [(text, loads)] of statements that change what it names
        self.identity_of_code = identity_of_code
        self.parse()

    def render(self, ins, start):
        code = self.code
        parts = []
        for offset, name, arg in ins:
            if arg is None: parts.append(name)
            elif name == 'LOAD_CONST':
                value = code.co_consts[arg]
                parts.append('%s %s' % (name, ('C' + self.identity_of_code(value)) if hasattr(value, 'co_code') else repr(value)))
            elif name in NAMES: parts.append('%s %s' % (name, code.co_names[arg]))
            elif name in ('LOAD_FAST', 'STORE_FAST', 'DELETE_FAST'): parts.append('%s %s' % (name, code.co_varnames[arg]))
            elif dis.opmap.get(name) in dis.hasjabs: parts.append('%s %d' % (name, arg - start))
            else: parts.append('%s %d' % (name, arg))
        return '; '.join(parts)

    def parse(self):
        code, current, importing, attr = self.code, [], None, None
        for offset, name, arg in instructions(code):
            if name == 'IMPORT_NAME':
                consts = [code.co_consts[a] for o, n, a in current if n == 'LOAD_CONST']
                level = consts[-2] if len(consts) >= 2 and isinstance(consts[-2], int) else -1
                importing, attr = (code.co_names[arg], level), None
                current = [(offset, name, arg)]
                continue
            if importing is not None:
                if name == 'IMPORT_FROM':
                    attr = code.co_names[arg]
                    continue
                if name == 'IMPORT_STAR' or name == 'POP_TOP':
                    current, importing, attr = [], None, None
                    continue
                if name in STORE:
                    target = code.co_names[arg]
                    if attr is not None:
                        # from X import attr (as target): the statement goes on with the next IMPORT_FROM or a POP_TOP
                        self.bindings.setdefault(target, []).append(('import', importing[0], importing[1], attr))
                        attr = None
                        continue
                    dotted = importing[0]
                    attrs = [code.co_names[a] for o, n, a in current if n == 'LOAD_ATTR']
                    if attrs or target != dotted.split('.')[0]: module = dotted         # import X.Y as Z, import X as Z
                    else: module = dotted.split('.')[0]                                 # import X / import X.Y binds X
                    self.bindings.setdefault(target, []).append(('module', module, importing[1]))
                    current, importing = [], None
                    continue
                current.append((offset, name, arg))
                continue
            current.append((offset, name, arg))
            if name not in END: continue
            start = current[0][0]
            names = [code.co_names[a] for o, n, a in current if n in ('LOAD_NAME', 'LOAD_GLOBAL')]
            text = self.render(current, start)
            if name in STORE:
                self.bindings.setdefault(code.co_names[arg], []).append(('value', text, names))
            else:
                for loaded in set(names): self.touches.setdefault(loaded, []).append((text, names))
            current = []

    def attribute_uses(self, binding):
        """The attributes the module's code reads off a name it binds to a module: LOAD_GLOBAL/NAME binding; LOAD_ATTR n."""
        found, stack = set(), [self.code]
        while stack:
            code = stack.pop()
            stack.extend(c for c in code.co_consts if hasattr(c, 'co_code'))
            ins = instructions(code)
            for k in range(len(ins) - 1):
                if ins[k][1] in ('LOAD_GLOBAL', 'LOAD_NAME') and code.co_names[ins[k][2]] == binding and ins[k + 1][1] == 'LOAD_ATTR':
                    found.add(code.co_names[ins[k + 1][2]])
        return found


class Objects(object):
    """The identities of what the set takes from outside it. `read(path)` -> the .pyc bytes; `exists(path)`; `crc(path)`
    -> '%08x:%d' of a path (for a module that does not decode); `identity_of_code` -> exporter.code_identity."""

    def __init__(self, read, exists, crc, identity_of_code):
        self.read, self.exists, self.crc, self.identity_of_code = read, exists, crc, identity_of_code
        self.modules = {}
        self.read_paths = set()

    def module(self, path):
        if path not in self.modules:
            self.read_paths.add(path)
            try:
                code = marshal.loads(self.read(path)[8:])
                self.modules[path] = Module(path, code, self.identity_of_code)
            except Exception:
                self.modules[path] = None
        return self.modules[path]

    def resolve(self, importer, name, level):
        """The .pyc path of module `name` as imported from `importer` (Python 2: relative to its package first, then from
        the scripts' roots), None when the client has none."""
        package = importer.rsplit('/', 1)[0]
        if level and level > 0:
            for _ in range(level - 1): package = package.rsplit('/', 1)[0]
            bases = [package]
        else:
            bases = ([package] if level != 0 else []) + ['scripts/common', 'scripts/client', 'scripts/client_common',
                                                         'scripts/common/Lib']
        tail = name.replace('.', '/') if name else ''
        for base in bases:
            for candidate in (base + '/' + tail + '.pyc', base + '/' + tail + '/__init__.pyc') if tail else (base + '/__init__.pyc',):
                if self.exists(candidate): return candidate
        return None

    def identity(self, path, name, depth=DEPTH, seen=None):
        """The identity of `name` as module `path` defines it (see the module's text)."""
        seen = set() if seen is None else seen
        if (path, name) in seen: return 'cycle'
        seen.add((path, name))
        module = self.module(path)
        if module is None: return 'bytes:%s' % self.crc(path)
        parts = []
        for binding in module.bindings.get(name, ()):
            if binding[0] == 'import':
                source = self.resolve(path, binding[1], binding[2])
                if source is None: parts.append('import %s.%s' % (binding[1], binding[3]))
                else:
                    sub = self.resolve(source, binding[3], 1) if source.endswith('/__init__.pyc') else None
                    parts.append('import %s' % (sub if sub else self.identity(source, binding[3], depth, seen)))
            elif binding[0] == 'module':
                parts.append('module %s' % (self.resolve(path, binding[1], binding[2]) or binding[1]))
            else:
                parts.append(self.with_loads(path, binding[1], binding[2], depth, seen))
        for text, loads in module.touches.get(name, ()):
            parts.append('touch ' + self.with_loads(path, text, loads, depth, seen))
        if not parts: parts.append('undefined %s' % name)
        return hashlib.sha1('\n'.join(parts).encode('utf-8')).hexdigest()

    def with_loads(self, path, text, loads, depth, seen):
        if depth <= 0: return text
        return text + ' | ' + ','.join('%s=%s' % (n, self.identity(path, n, depth - 1, seen)) for n in sorted(set(loads)))

    def external(self, set_paths):
        """{'<module path>:<name>': identity} of every name the set's modules take from modules outside the set."""
        inside = set(set_paths)
        wanted = set()
        for path in sorted(inside):
            module = self.module(path)
            if module is None: continue
            for target, bindings in module.bindings.items():
                for binding in bindings:
                    if binding[0] == 'import':
                        source = self.resolve(path, binding[1], binding[2])
                        if source is None: continue
                        sub = self.resolve(source, binding[3], 1) if source.endswith('/__init__.pyc') else None
                        if sub is not None: continue          # a submodule: a module of its own, in the set or not
                        if source not in inside: wanted.add((source, binding[3]))
                    elif binding[0] == 'module':
                        source = self.resolve(path, binding[1], binding[2])
                        if source is None or source in inside: continue
                        for attr in module.attribute_uses(target): wanted.add((source, attr))
        return dict(('%s:%s' % (source, name), self.identity(source, name)) for source, name in sorted(wanted))
