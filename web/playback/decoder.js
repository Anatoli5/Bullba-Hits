// Bullba Hits' 3D replay player (19.11.2026): the replay decoder in the page - the JS prototype of 12.11
// (work/decoder-probe/js/decoder.js, the same events as the Python decoder on 34 of 34 battles,
// outputs/decoder-rust-vs-js-2026-11-12.md section 4) with the three rules the Python decoder gained after it (12.11,
// BACKLOG 96: 0x80|n in an entity state's child ids is a run of ids; STRING / PYTHON component properties come raw; a
// nested update into a FIXED_DICT the state left out starts from its default). Packet walk + entity/component decode of a
// WoT .wotreplay packet stream, the same events as mod/local_armor_inspector/replay_stream.py (Decoder.decode) +
// replay_objects.py. The client's definitions come from the mod (playback.definitions_value: its own Defs/Registry,
// data/playback/defs-<crc>.js). Loaded by the battle worker (battle-page.js) and by node in the tests.
'use strict';
// Values: Python int -> Number (BigInt for INT64/UINT64 and big pickle ints), float -> Number, str -> string,
// bytes -> Uint8Array, list/tuple -> Array, event and FIXED_DICT dicts -> plain objects, pickle dicts -> PyDict,
// sets -> PySet, pickle stubs -> Stub. A Python exception is mirrored by a throw at the same place.

class IndexErr extends Error {}
class StructErr extends Error {}
class ValueErr extends Error {}

// ---- byte access with Python's failure points ------------------------------------------------------------------------
let dvBuf = null, dv = null;
function view(b) { if (b.buffer !== dvBuf) { dvBuf = b.buffer; dv = new DataView(dvBuf); } return dv; }
function u8(b, p) { if (p >= b.length || p < 0) throw new IndexErr('bytearray index out of range'); return b[p]; }
function need(b, p, n) { if (p < 0 || p + n > b.length) throw new StructErr('unpack_from short buffer'); }
function U32(b, p) { need(b, p, 4); return view(b).getUint32(b.byteOffset + p, true); }
function I32(b, p) { need(b, p, 4); return view(b).getInt32(b.byteOffset + p, true); }
function U16(b, p) { need(b, p, 2); return view(b).getUint16(b.byteOffset + p, true); }
function U16BE(b, p) { need(b, p, 2); return view(b).getUint16(b.byteOffset + p, false); }
function F32(b, p) { need(b, p, 4); return view(b).getFloat32(b.byteOffset + p, true); }
function F64(b, p) { need(b, p, 8); return view(b).getFloat64(b.byteOffset + p, true); }
function slice(b, a, z) { if (a > b.length) a = b.length; if (z > b.length) z = b.length; if (z < a) z = a; return b.subarray(a, z); }
const HEX = []; for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));
function hexs(b) { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; }
function ascii(b) { let s = ''; for (let i = 0; i < b.length; i++) s += b[i] < 128 ? String.fromCharCode(b[i]) : '�'; return s; }
function latin1(b) { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
function find(b, pat, from) {
  outer: for (let i = from || 0; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

// ---- Python-like containers for pickles ------------------------------------------------------------------------------
class PyDict { constructor() { this.m = new Map(); } }
class PySet { constructor() { this.m = new Map(); } }
class Stub { constructor(name) { this.name = name; } }

// ---- types from the schema -------------------------------------------------------------------------------------------
// read(b, pos) returns the value and leaves the new position in NP (one shared cell: no pair allocated per value).
let NP = 0;
function packedLen(b, pos) {
  const n = u8(b, pos);
  if (n === 0xff) { const v = u8(b, pos + 1) | (u8(b, pos + 2) << 8) | (u8(b, pos + 3) << 16); NP = pos + 4; return v; }
  NP = pos + 1; return n;
}
function simpleReader(fmt) {
  const one = (c) => {
    switch (c) {
      case 'b': return [1, (b, p) => { need(b, p, 1); return view(b).getInt8(b.byteOffset + p); }];
      case 'B': return [1, (b, p) => { need(b, p, 1); return b[p]; }];
      case 'h': return [2, (b, p) => { need(b, p, 2); return view(b).getInt16(b.byteOffset + p, true); }];
      case 'H': return [2, U16];
      case 'i': return [4, I32];
      case 'I': return [4, U32];
      case 'q': return [8, (b, p) => { need(b, p, 8); return view(b).getBigInt64(b.byteOffset + p, true); }];
      case 'Q': return [8, (b, p) => { need(b, p, 8); return view(b).getBigUint64(b.byteOffset + p, true); }];
      case 'f': return [4, F32];
      case 'd': return [8, F64];
    }
    throw new Error('format ' + c);
  };
  if (fmt.length === 1) {
    const [size, r] = one(fmt);
    return (b, p) => { const v = r(b, p); NP = p + size; return v; };
  }
  const parts = [...fmt].map(one);
  let total = 0; for (const [s] of parts) total += s;
  return (b, p) => {
    need(b, p, total);   // struct checks the whole format before reading
    const out = []; let q = p;
    for (const [s, r] of parts) { out.push(r(b, q)); q += s; }
    NP = p + total; return out;
  };
}
function readBytes(b, pos) { const n = packedLen(b, pos); const s = NP; NP = s + n; return slice(b, s, s + n).slice(); }

function buildTypes(table) {
  const T = table.map(() => ({}));
  table.forEach((d, i) => {
    const t = T[i];
    t.kind = d.k;
    if (d.k === 'num') t.read = simpleReader(d.f);
    else if (d.k === 'str' || d.k === 'blob') t.read = readBytes;
    else if (d.k === 'mailbox') t.read = (b, p) => { const v = hexs(slice(b, p, p + 12)); NP = p + 12; return v; };
  });
  table.forEach((d, i) => {
    const t = T[i];
    if (d.k === 'array') {
      const of = T[d.of]; t.children = [of];
      if (d.n !== null && d.n !== undefined) {
        const n = d.n;
        t.read = (b, p) => { const out = new Array(n); for (let k = 0; k < n; k++) { out[k] = of.read(b, p); p = NP; } NP = p; return out; };
      } else {
        t.read = (b, p) => { const n = packedLen(b, p); p = NP; const out = new Array(n); for (let k = 0; k < n; k++) { out[k] = of.read(b, p); p = NP; } NP = p; return out; };
      }
    } else if (d.k === 'dict') {
      t.children = d.fields.map(([n, x]) => [n, T[x]]);
      const names = t.children.map((f) => f[0]), readers = t.children.map((f) => f[1]);
      const none = !!d.none, nf = names.length;
      t.read = (b, p) => {
        if (none) { const flag = u8(b, p); p += 1; if (!flag) { NP = p; return null; } }
        const out = {};
        for (let k = 0; k < nf; k++) { out[names[k]] = readers[k].read(b, p); p = NP; }
        NP = p; return out;
      };
    }
  });
  return T;
}

const CLIENT_FLAGS = new Set(['ALL_CLIENTS', 'OTHER_CLIENTS', 'OWN_CLIENT', 'BASE_AND_CLIENT', 'CELL_PUBLIC_AND_OWN']);
const CELL_CLIENT_FLAGS = new Set(['ALL_CLIENTS', 'OWN_CLIENT', 'CELL_PUBLIC_AND_OWN', 'OTHER_CLIENTS']);

class Schema {
  constructor(json) {
    this.json = json;
    const T = this.types = buildTypes(json.types);
    this.entities = json.entities;
    this.argNames = json.argNames;
    this.arenaUpdate = json.arenaUpdate;
    this.packetNames = json.packetNames;
    this.specs = {};
    for (const [name, s] of Object.entries(json.entitySpecs)) {
      if (!s) { this.specs[name] = null; continue; }
      this.specs[name] = {
        name,
        clientProps: s.clientProps.map(([n, t]) => [n, T[t]]),
        clientMethods: s.clientMethods.map(([n, args]) => [n, args.map(([a, t]) => [a, T[t]])]),
        props: s.props.map(([n, t, f]) => [n, T[t], f]),
      };
    }
    this.dynamic = json.dynamic;
    this.base = json.base;
    this.comps = {};
    for (const [name, s] of Object.entries(json.components)) {
      if (!s) { this.comps[name] = null; continue; }
      const props = s.props.map(([n, t]) => [n, T[t]]);
      this.comps[name] = { name, props, sortedMethods: s.methods.map(([n, args]) => [n, args.map(([a, t]) => [a, T[t]])]),
        detail: new Set(s.detail), iface: new Set(s.iface), members: s.members };
    }
  }
  spec(name) { const s = this.specs[name]; return s === undefined ? null : s; }
  comp(name) { const s = this.comps[name]; return s === undefined ? null : s; }
}

function propsFor(spec, members) {
  const nm = spec.sortedMethods.length;
  const drops = [new Set(), spec.detail, spec.iface, new Set([...spec.detail, ...spec.iface])];
  for (const drop of drops) {
    const props = spec.props.filter((x) => !drop.has(x[0]));
    if (props.length + nm === members) return props;
  }
  return null;
}

// ---- formulas ----------------------------------------------------------------------------------------------------------
function decodeGunAngles(code) {
  const yaw = 2.0 * Math.PI * ((code >> 6) & 1023) / 1024.0 - Math.PI;
  return [yaw, (code & 63) / 63.0];
}
function decodeHitPoint(hp) {
  const seg = BigInt(hp.segment), params = hp.params;
  const B = (s) => Number((seg >> BigInt(s)) & 255n);
  return {
    networkID: hp.networkID, part: B(8), effect: Number(seg & 255n), hitType: params & 15, shellType: (params >> 4) & 15,
    caliber: Number((((params >> 8) & 0xffff) * 0.1).toFixed(1)),
    startQ: [B(16), B(24), B(32)], endQ: [B(40), B(48), B(56)], segment: seg.toString(), params,
  };
}

// ---- pickles (Python 2 protocol 0-2 subset; mode 'bytes' = safe_unpickle with stubs, 'latin1' = battle results) --------
const MARK = {};
function unpickle(raw, mode) {
  const stack = [], memo = new Map(); let p = 0;
  const pop = () => { if (!stack.length) throw new Error('stack underflow'); return stack.pop(); };
  const popMark = () => { let i = stack.length - 1; while (i >= 0 && stack[i] !== MARK) i--; if (i < 0) throw new Error('no mark'); const items = stack.splice(i + 1); stack.pop(); return items; };
  const str8 = (b) => mode === 'latin1' ? latin1(b) : b.slice();
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const setitem = (d, k, v) => { if (!(d instanceof PyDict)) throw new Error('setitem'); d.m.set(canonKey(k), [k, v]); };
  const findClass = (module, name) => {
    if (mode === 'latin1') {
      if ((module === '__builtin__' || module === 'builtins') && (name === 'set' || name === 'frozenset')) return { builtin: name };
      throw new Error('forbidden ' + module + '.' + name);
    }
    return { stub: (module === '__builtin__' ? 'builtins' : module) + '.' + name };
  };
  const call = (cls, args) => {
    if (cls.builtin) { const s = new PySet(); s.frozen = cls.builtin === 'frozenset'; const it = args.length ? args[0] : [];
      for (const x of iterOf(it)) s.m.set(canonKey(x), x); return s; }
    const o = new Stub(cls.stub); o.args = args; return o;
  };
  const line = () => { const e = raw.indexOf(10, p); if (e < 0) throw new Error('no newline'); const s = latin1(raw.subarray(p, e)); p = e + 1; return s; };
  const need2 = (n) => { if (p + n > raw.length) throw new Error('truncated'); };
  for (;;) {
    if (p >= raw.length) throw new Error('pickle exhausted');
    const op = raw[p++];
    switch (op) {
      case 0x80: need2(1); p += 1; break;                                       // PROTO
      case 0x2e: return pop();                                                  // STOP
      case 0x28: stack.push(MARK); break;                                       // MARK
      case 0x74: stack.push(popMark()); break;                                  // TUPLE
      case 0x29: stack.push([]); break;                                         // EMPTY_TUPLE
      case 0x85: stack.push([pop()]); break;                                    // TUPLE1
      case 0x86: { const b = pop(), a = pop(); stack.push([a, b]); break; }     // TUPLE2
      case 0x87: { const c = pop(), b = pop(), a = pop(); stack.push([a, b, c]); break; }
      case 0x5d: stack.push([]); break;                                         // EMPTY_LIST
      case 0x6c: stack.push(popMark()); break;                                  // LIST
      case 0x61: { const v = pop(); stack[stack.length - 1].push(v); break; }   // APPEND
      case 0x65: { const items = popMark(); const l = stack[stack.length - 1]; for (const x of items) l.push(x); break; }
      case 0x7d: stack.push(new PyDict()); break;                               // EMPTY_DICT
      case 0x64: { const items = popMark(); const d = new PyDict(); for (let i = 0; i < items.length; i += 2) setitem(d, items[i], items[i + 1]); stack.push(d); break; }
      case 0x73: { const v = pop(), k = pop(); setitem(stack[stack.length - 1], k, v); break; }   // SETITEM
      case 0x75: { const items = popMark(); const d = stack[stack.length - 1]; for (let i = 0; i < items.length; i += 2) setitem(d, items[i], items[i + 1]); break; }
      case 0x71: need2(1); memo.set(raw[p++], stack[stack.length - 1]); break; // BINPUT
      case 0x72: need2(4); memo.set(U32(raw, p), stack[stack.length - 1]); p += 4; break;
      case 0x68: need2(1); { const k = raw[p++]; if (!memo.has(k)) throw new Error('memo'); stack.push(memo.get(k)); } break;
      case 0x6a: need2(4); { const k = U32(raw, p); p += 4; if (!memo.has(k)) throw new Error('memo'); stack.push(memo.get(k)); } break;
      case 0x4e: stack.push(null); break;                                       // NONE
      case 0x88: stack.push(true); break;
      case 0x89: stack.push(false); break;
      case 0x4a: need2(4); stack.push(I32(raw, p)); p += 4; break;              // BININT
      case 0x4b: need2(1); stack.push(raw[p++]); break;                         // BININT1
      case 0x4d: need2(2); stack.push(U16(raw, p)); p += 2; break;              // BININT2
      case 0x47: need2(8); stack.push(view(raw).getFloat64(raw.byteOffset + p, false)); p += 8; break;   // BINFLOAT
      case 0x49: { const s = line(); if (s === '00') stack.push(false); else if (s === '01') stack.push(true);  // INT
        else { const v = BigInt(s.trim()); stack.push(v >= -(2n ** 53n) && v < 2n ** 53n ? Number(v) : v); } break; }
      case 0x8a: { need2(1); const n = raw[p++]; need2(n); let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(raw[p + i]);
        if (n && raw[p + n - 1] & 0x80) v -= 1n << BigInt(8 * n); p += n; stack.push(v >= -(2n ** 53n) && v < 2n ** 53n ? Number(v) : v); break; }
      case 0x55: { need2(1); const n = raw[p++]; need2(n); stack.push(str8(raw.subarray(p, p + n))); p += n; break; }   // SHORT_BINSTRING
      case 0x54: { need2(4); const n = I32(raw, p); p += 4; if (n < 0) throw new Error('neg'); need2(n); stack.push(str8(raw.subarray(p, p + n))); p += n; break; }
      case 0x58: { need2(4); const n = U32(raw, p); p += 4; need2(n); stack.push(utf8.decode(raw.subarray(p, p + n))); p += n; break; }
      case 0x63: { const module = line(), name = line(); stack.push(findClass(module, name)); break; }   // GLOBAL
      case 0x81: { const args = pop(), cls = pop(); if (cls.builtin) stack.push(call(cls, args)); else stack.push(new Stub(cls.stub)); break; }   // NEWOBJ
      case 0x52: { const args = pop(), cls = pop(); if (!cls || (!cls.builtin && !cls.stub)) throw new Error('reduce'); stack.push(call(cls, args)); break; }
      case 0x62: { const state = pop(); const inst = stack[stack.length - 1]; if (!(inst instanceof Stub)) throw new Error('build'); inst.state = state; break; }
      default: throw new Error('opcode 0x' + op.toString(16));
    }
  }
}
function* iterOf(x) {
  if (Array.isArray(x)) yield* x;
  else if (x instanceof PySet) yield* x.m.values();
  else if (x instanceof PyDict) for (const [k] of x.m.values()) yield k;
  else if (typeof x === 'string') yield* x;
  else if (x instanceof Uint8Array) yield* x;
  else throw new Error('not iterable');
}

function safeUnpickle(raw) {
  if (!(raw instanceof Uint8Array) || raw[0] !== 0x80) return null;
  try { return unpickle(raw, 'bytes'); } catch (e) { return null; }
}

// ---- canonical text (py/canon.py) --------------------------------------------------------------------------------------
const F64BUF = new DataView(new ArrayBuffer(8));
const TWO53 = 2 ** 53;
const ENC = new TextEncoder();
function canon(v) {
  if (v === null || v === undefined) return 'N';
  if (v === true) return 'T';
  if (v === false) return 'F';
  const t = typeof v;
  if (t === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < TWO53) return 'n' + (v === 0 ? '0' : String(v));
    F64BUF.setFloat64(0, v, false); let s = 'f'; for (let i = 0; i < 8; i++) s += HEX[F64BUF.getUint8(i)]; return s;
  }
  if (t === 'bigint') return 'n' + v.toString();
  if (t === 'string') return 's' + hexs(ENC.encode(v));
  if (v instanceof Uint8Array) return 'b' + hexs(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v instanceof PyDict) return '{' + [...v.m.values()].map(([k, x]) => canon(k) + ':' + canon(x)).sort().join(',') + '}';
  if (v instanceof PySet) return '<' + [...v.m.values()].map(canon).sort().join(',') + '>';
  if (v instanceof Stub) {
    let s = '@' + canon(v.name);
    if ('args' in v) s += 'a' + canon(v.args);
    if ('state' in v) s += 's' + canon(v.state);
    return s;
  }
  if (t === 'object') return '{' + Object.keys(v).map((k) => canon(k) + ':' + canon(v[k])).sort().join(',') + '}';
  throw new Error('no canonical form for ' + t);
}
function canonKey(k) { return canon(k); }
function canonEvent(ev) {
  if ('error' in ev && (ev.ev === 'undecoded' || ev.ev === 'component_undecoded')) { const c = Object.assign({}, ev); delete c.error; return canon(c); }
  return canon(ev);
}

// ---- component layer (replay_objects.py) --------------------------------------------------------------------------------
function bitsFor(n) { if (n === 0) return 1; if (n === 1) return 0; return 32 - Math.clz32(n - 1); }   // max(0, (n - 1).bit_length()): 1 for 0
class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(n) { let v = 0; for (let i = 0; i < n; i++) { const byte = u8(this.buf, this.pos >> 3); v = (v * 2) + ((byte >> (7 - (this.pos & 7))) & 1); this.pos++; } return v; }
  aligned() { return (this.pos + 7) >> 3; }
}
function defaultValue(ty) { if (ty.kind === 'array') return []; if (ty.kind === 'num') return 0; return null; }
function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v instanceof Uint8Array) return v;
  if (v !== null && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepCopy(v[k]); return o; }
  return v;
}
function defaultDict(ty) { const o = {}; for (const [n, t] of ty.children) o[n] = t.kind === 'dict' ? defaultDict(t) : defaultValue(t); return o; }
function isDict(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array); }

function nestedUpdate(inst, m, mode, raw) {
  const props = inst.props;
  const br = new BitReader(raw);
  if (br.read(1) !== 1) throw new ValueErr('path does not enter the property');
  if (br.read(bitsFor(props.length)) !== m) throw new ValueErr('path names another property');
  const [pname, ty0] = props[m]; let ty = ty0;
  let value = inst.values[pname];
  if (value === undefined) value = null;
  if (value === null && ty.kind === 'array') { value = inst.values[pname] = []; }
  const path = [pname];
  let holder = null, key = null;
  for (;;) {
    const descend = br.read(1);
    if (ty.kind === 'array') {
      if (!Array.isArray(value)) throw new ValueErr('array length unknown');
      const length = value.length;
      if (descend) {
        const i = br.read(bitsFor(length));
        path.push(i);
        if (i >= length) throw new IndexErr('list index out of range');
        holder = value; key = i;
        value = value[i]; ty = ty.children[0];
        continue;
      }
      const sub = ty.children[0];
      if (mode === 1) {
        const w = bitsFor(length + 1);
        const a = br.read(w), z = br.read(w);
        let pos = br.aligned(); const items = [];
        while (pos < raw.length) { items.push(sub.read(raw, pos)); pos = NP; }
        const s = Math.min(a, length), e = Math.max(s, Math.min(z, length));
        value.splice(s, e - s, ...items);
        return { path, slice: [a, z], value: items };
      }
      const i = br.read(bitsFor(length));
      const v = sub.read(raw, br.aligned()); const pos = NP;
      if (pos !== raw.length) throw new ValueErr('element used');
      if (i < length) value[i] = v;
      return { path: path.concat([i]), value: v };
    }
    if (ty.kind === 'dict') {
      const fields = ty.children;
      const i = br.read(bitsFor(fields.length));
      if (i >= fields.length) throw new IndexErr('list index out of range');
      const [fname, fty] = fields[i];
      if (descend) {
        path.push(fname);
        if (value === null || value === undefined) {
          // a dict the state left out (12.11, Fort Rush vehicleScore): its default, then the field
          value = defaultDict(ty);
          if (holder === null) inst.values[pname] = value; else holder[key] = value;
        }
        holder = value; key = fname;
        if (isDict(value) && (value[fname] === null || value[fname] === undefined) && fty.kind === 'array') value[fname] = [];
        if (!isDict(value) || !(fname in value)) throw new Error('KeyError ' + fname);
        value = value[fname]; ty = fty;
        continue;
      }
      const v = fty.read(raw, br.aligned()); const pos = NP;
      if (pos !== raw.length) throw new ValueErr('field used');
      if (isDict(value)) value[fname] = v;
      return { path: path.concat([fname]), value: v };
    }
    throw new ValueErr('cannot descend into ' + ty.kind);
  }
}

class Instance {
  constructor(cid, owner, typ, name, label, spec) {
    this.cid = cid; this.owner = owner; this.typ = typ; this.name = name; this.label = label; this.spec = spec;
    this.methods = spec ? spec.sortedMethods.slice() : [];
    this.props = spec ? spec.props.slice() : [];
    this.values = {};
    this.members = spec ? spec.members : 0;
    this.ids = [];
  }
}

class ObjectTable {
  constructor(schema) {
    this.schema = schema; this.base = schema.base;
    this.entities = new Map(); this.instances = new Map(); this.ids = new Map(); this.pending = []; this.failures = 0;
  }
  regName(typ) { const i = typ - this.base; return i >= 0 && i < this.schema.dynamic.length ? this.schema.dynamic[i] : null; }
  create(p) {
    const out = []; let off = 0;
    while (off + 4 <= p.length) {
      const n = U32(p, off); const b = slice(p, off + 4, off + 4 + n); off += 4 + n;
      try { this.frame(b, out); } catch (e) { this.failures++; }
    }
    return out;
  }
  retry() { const held = this.pending; this.pending = []; const out = []; for (const [t, b] of held) for (const e of this.messages(b, t)) out.push(e); return out; }
  flush() { const held = this.pending; this.pending = []; const out = []; for (const [t, b] of held) for (const e of this.messages(b, t, false, false)) out.push(e); return out; }
  frame(b, out) {
    // events of a frame that raises half way are lost in Python (the list is local): collect locally, then append
    const local = []; let pos = 0;
    while (pos + 5 <= b.length) {
      const oid = U16BE(b, pos), par = U16BE(b, pos + 2);
      const kind = b[pos + 4];
      if (kind === 1) {
        const eid = U32(b, pos + 5);
        this.entities.set(oid, eid);
        local.push({ ev: 'object', oid, entityId: eid });
        pos += 9;
        if (pos < b.length) {
          const hasState = b[pos]; pos += 1;
          if (hasState) pos = this.entityState(b, pos, oid, eid, local);
        }
      } else if (kind === 2) {
        const owner = this.entities.has(par) ? this.entities.get(par) : par;
        pos = this.component(b, pos + 5, oid, owner, local);
      } else {
        for (let i = pos; i < b.length; i++) if (b[i]) throw new ValueErr('record kind');
        break;
      }
    }
    for (const e of local) out.push(e);
  }
  entityState(b, pos, oid, eid, out) {
    if (U16BE(b, pos) !== oid) throw new ValueErr('entity state names another object');
    pos += 2;
    const ids = []; let cur = oid;
    while (u8(b, pos) !== 0) {
      if (b[pos] === 0x80) { cur = (u8(b, pos + 1) << 8) | u8(b, pos + 2); pos += 3; }
      else if (b[pos] & 0x80) {   // 0x80|n: the next n - 2 consecutive ids (replay_objects.ObjectTable._entity_state, 12.11)
        const n = (b[pos] & 0x7f) - 2; for (let k = 1; k <= n; k++) ids.push(cur + k);
        if (ids.length) cur = ids[ids.length - 1]; pos += 1; continue;
      } else { cur += b[pos]; pos += 1; }
      ids.push(cur);
    }
    pos += 1;
    for (const cid of ids) {
      if (u8(b, pos) !== 2) throw new ValueErr('child kind');
      pos = this.component(b, pos + 1, cid, eid, out);
    }
    return pos;
  }
  component(b, pos, cid, owner, out) {
    const typ = u8(b, pos);
    const ln = U16BE(b, pos + 1);
    const label = latin1(slice(b, pos + 3, pos + 3 + ln));
    pos += 3 + ln;
    const name = this.regName(typ);
    const spec = name ? this.schema.comp(name) : null;
    const inst = new Instance(cid, owner, typ, name, label, spec);
    const ids = this.memberIds(b, pos, cid); pos = NP;
    const members = ids.length - 1;
    inst.members = members; inst.ids = ids.slice(0, members);
    const nmask = (ids.length + 7) >> 3;
    const mask = slice(b, pos + 1, pos + 1 + nmask);
    pos += 1 + nmask;
    this.drop(cid); for (const i of inst.ids) this.drop(i);
    this.ids.set(cid, [inst, null]);
    inst.ids.forEach((i, j) => this.ids.set(i, [inst, j]));
    const ev = { ev: 'component', cid, owner, type: typ, component: name, label, members };
    const props = spec ? propsFor(spec, members) : null;
    if (props === null) {
      ev.note = 'state not decoded (' + members + ' members in the stream, ' + (spec ? spec.members : 'None') + ' in the .def)';
      this.instances.set(cid, inst);
      out.push(ev);
      throw new ValueErr('cannot skip the state');
    }
    inst.props = props;
    const np = props.length; const table = [];
    for (let j = 0; j < members; j++) {
      const bit = (j >> 3) < mask.length ? (mask[j >> 3] >> (j & 7)) & 1 : 0;
      if (!bit) { if (j < np) inst.values[props[j][0]] = defaultValue(props[j][1]); continue; }
      if (j < np) { inst.values[props[j][0]] = props[j][1].read(b, pos); pos = NP; }
      else { table.push(u8(b, pos)); pos += 1; }
    }
    if (table.length) inst.methods = table.map((i) => { if (i >= spec.sortedMethods.length) throw new IndexErr('list index out of range'); return spec.sortedMethods[i]; });
    ev.state = Object.assign({}, inst.values);
    this.instances.set(cid, inst);
    out.push(ev);
    return pos;
  }
  memberIds(b, pos, cid) {
    const ids = []; let cur = cid;
    for (;;) {
      const c = u8(b, pos);
      if (c === 0x82) { if (!ids.length) throw new ValueErr('empty id list'); NP = pos; return ids; }
      if (c === 0x80) { cur = (u8(b, pos + 1) << 8) | u8(b, pos + 2); ids.push(cur); pos += 3; }
      else if (c === 0x81) throw new ValueErr('0x81');
      else if (c & 0x80) { const n = (c & 0x7f) - 2; for (let k = 1; k <= n; k++) ids.push(cur + k); if (n > 0) cur = ids[ids.length - 1]; else if (!ids.length) throw new IndexErr('list index out of range'); else cur = ids[ids.length - 1]; pos += 1; }
      else { cur += c; ids.push(cur); pos += 1; }
      if (ids.length > 256) throw new ValueErr('member ids do not end');
    }
  }
  drop(i) {
    const hit = this.ids.get(i);
    if (hit !== undefined) {
      const inst = hit[0];
      for (const k of [inst.cid].concat(inst.ids)) { const h = this.ids.get(k); if (h !== undefined && h[0] === inst) this.ids.delete(k); }
    }
  }
  messages(b, t, dry = false, hold = true) {
    const out = []; let pos = 0;
    while (pos + 2 <= b.length) {
      const mid = (b[pos] << 8) | b[pos + 1];
      const hit = this.ids.get(mid);
      const inst = hit ? hit[0] : null, m = hit ? hit[1] : null;
      if (inst !== null && m === null) {
        out.push({ t, ev: 'component_removed', cid: mid, owner: inst.owner, component: inst.name });
        if (!dry) this.drop(mid);
        pos += 2; continue;
      }
      if (inst === null || inst.spec === null || m >= inst.members) {
        if (dry) return null;
        if (inst === null && hold) { this.pending.push([t, slice(b, pos, b.length).slice()]); return out; }
        this.failures++;
        return out.concat(this.resync(b, pos, t, mid));
      }
      const start = pos; pos += 2;
      let ev;
      try {
        if (m < inst.props.length) { ev = this.property(inst, m, b, pos, t, dry); pos = NP; }
        else {
          const k = m - inst.props.length;
          if (k >= inst.methods.length) throw new IndexErr('list index out of range');
          const [mname, args] = inst.methods[k];
          const vals = {};
          for (const [an, ty] of args) { vals[an] = ty.read(b, pos); pos = NP; }
          ev = { t, ev: 'component_method', owner: inst.owner, component: inst.name, name: mname, args: vals };
        }
      } catch (e) {
        if (dry) return null;
        this.failures++;
        return out.concat(this.resync(b, start, t, mid, String(e.message).slice(0, 120)));
      }
      out.push(ev);
    }
    return out;
  }
  resync(b, pos, t, mid, error) {
    for (let k = pos + 2; k < b.length - 1; k++) {
      if (this.messages(b.subarray(k), t, true) !== null) {
        const ev = { t, ev: 'component_undecoded', id: mid, raw: hexs(slice(b, pos, k)), resynced: true };
        if (error) ev.error = error;
        return [ev].concat(this.messages(b.subarray(k), t));
      }
    }
    const ev = { t, ev: 'component_undecoded', id: mid, raw: hexs(slice(b, pos, b.length)) };
    if (error) ev.error = error;
    return [ev];
  }
  property(inst, m, b, pos, t, dry) {
    const [pname, ty] = inst.props[m];
    const ev = { t, ev: 'component_property', owner: inst.owner, component: inst.name, name: pname };
    // raw value, no mode byte: the numbers, and STRING / PYTHON (12.11: FortRushScoreComponent.teamScore, a pickle)
    if (ty.kind === 'num' || ty.kind === 'str' || ty.kind === 'blob') { ev.value = ty.read(b, pos); if (!dry) inst.values[pname] = ev.value; return ev; }
    const mode = u8(b, pos);
    const ln = packedLen(b, pos + 1); const q = NP;
    const raw = slice(b, q, q + ln).slice();
    const end = q + ln;
    if (mode === 0) {
      ev.value = ty.read(raw, 0);
      if (NP !== ln) throw new ValueErr('used');
      if (!dry) inst.values[pname] = ev.value;
    } else {
      const target = dry ? { props: inst.props, values: deepCopy(inst.values) } : inst;
      Object.assign(ev, nestedUpdate(target, m, mode, raw));
    }
    NP = end;
    return ev;
  }
}

function smallPacket(ptype, p) {
  switch (ptype) {
    case 0x15: return { ev: 'server_time_at_start', serverTime: F64(p, 0) };
    case 0x16: return { ev: 'arena_period', period: U32(p, 0) };
    case 0x17: return { ev: 'arena_period_end', endTime: F32(p, 0) };
    case 0x1a: { need(p, 0, 60); const v = []; for (let i = 0; i < 15; i++) v.push(F32(p, 4 * i));
      return { ev: 'client_gun_marker', point: v.slice(0, 3), markerDiameter: v[3], dualAccDiameter: v[4], markerPosition: v.slice(5, 8),
        markerDirection: v.slice(8, 11), arcadeDiameter: v[11], dualAccSize: v[12], spg: v.slice(13, 15) }; }
    case 0x1c: case 0x1d: return { ev: ptype === 0x1c ? 'turret_yaw' : 'gun_pitch', value: F32(p, 0) };
    case 0x02: return { ev: 'entity_control', entityId: U32(p, 0), flag: p.length > 4 ? p[4] : null };
    case 0x0d: { need(p, 0, 12); const space = U32(p, 0), key = U32(p, 4), n = U32(p, 8); return { ev: 'space_data_entry', spaceId: space, key, value: hexs(slice(p, 12, 12 + n)) }; }
    case 0x12: return { ev: 'flag_0x12', value: u8(p, 0) };
    case 0x1e: return { ev: 'ammo_button', index: U32(p, 0) };
    case 0x11: return battleResults(p);
    case 0x1f: { const v = U32(p, 0); return { ev: 'net_stats', fps: v & 255, ping: (v >>> 8) & 0xffff, lag: v >>> 24 }; }
    case 0x20: { need(p, 0, 8); return { ev: 'client_reload', values: [F32(p, 0), F32(p, 4)] }; }
    case 0x22: return { ev: 'own_vehicle', vehicleId: U32(p, 0) };
    case 0x26: { need(p, 0, 40); const v = []; for (let i = 0; i < 10; i++) v.push(F32(p, 4 * i));
      return { ev: 'camera', rotation: v.slice(0, 4), offset: v.slice(4, 7), fov: v[7], extra: v.slice(8, 10) }; }
    case 0x28: return { ev: 'target_lock', state: U32(p, 0) };
    case 0x2b: return { ev: 'period_flag', value: u8(p, 0) };
    case 0x2e: return { ev: 'sniper_mode', on: !!u8(p, 0) };
    case 0x35: return { ev: 'object_removed_marker' };
    case 0x36: return null;
    case 0x2d: case 0x30: case 0x3d: { const n = U32(p, 0); return { ev: { 0x2d: 'client_tuple', 0x30: 'client_quality', 0x3d: 'client_hash' }[ptype], text: ascii(slice(p, 4, 4 + n)) }; }
    case 0x39:
      if (p.length >= 15) {
        const ev = { ev: 'volatile', tick: U32(p, 15), len: p.length };
        if (p.length === 72 && p[41] === 1) return { ev: 'server_gun_marker', tick: ev.tick, len: ev.len,
          gunPosition: [F32(p, 42), F32(p, 46), F32(p, 50)], shotVector: [F32(p, 54), F32(p, 58), F32(p, 62)], dispersion: F32(p, 66) };
        return ev;
      }
      return null;
  }
  return null;
}
const SMALL = new Set([0x02, 0x0d, 0x11, 0x12, 0x15, 0x16, 0x17, 0x1a, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x22, 0x26, 0x28, 0x2b, 0x2d, 0x2e, 0x30, 0x35, 0x36, 0x39, 0x3d]);

let INFLATE = null;   // set by the host: Uint8Array -> Uint8Array (node: zlib.inflateSync)
function battleResults(p) {
  const i = find(p, [0x78, 0x01]);
  const from = i < 0 ? p.length - 1 : i;
  const outer = unpickle(INFLATE(slice(p, from, p.length)), 'latin1');
  const parts = outer.slice(1).map((x) => unpickle(INFLATE(typeof x === 'string' ? Uint8Array.from(x, (c) => c.charCodeAt(0)) : x), 'latin1'));
  return { ev: 'battle_results', arenaUniqueID: outer[0], parts };
}

function calibrateBase(stream, schema) {
  const own = schema.comp('OwnVehicle');
  if (!own) return schema.base;
  const head = 0x80 | (own.members + 3);
  const pat = [0, 0, head, 0x82];
  let off = 0; const n = stream.length;
  while (off + 12 <= n) {
    const size = U32(stream, off), ptype = U32(stream, off + 4);
    if (off + 12 + size > n) break;
    if (ptype === 0x32) {
      const p = stream.subarray(off + 12, off + 12 + size);
      let i = find(p, pat);
      while (i >= 2) { if (p[i - 2] === 2) return p[i - 1]; i = find(p, pat, i + 1); }
    }
    off += 12 + size;
  }
  return schema.base;
}

// ---- the decoder ------------------------------------------------------------------------------------------------------
class Decoder {
  constructor(schema, opts) {
    this.schema = schema; this.entities = new Map(); this.values = new Map(); this.playerId = null; this.partialBytes = 0;
    this.skip = (opts && opts.skip) || null; this.skipProps = (opts && opts.skipProperties) ? new Set(opts.skipProperties) : null;
    this.skipIds = new Map(); this.skipped = 0; this.lastClock = null;
  }
  typeName(typ) { const i = typ - 1; return i >= 0 && i < this.schema.entities.length ? this.schema.entities[i] : 'entityType' + typ; }
  propsBlob(spec, blob) {
    const n = u8(blob, 0); let pos = 1; const out = {};
    for (let k = 0; k < n; k++) {
      const idx = u8(blob, pos); pos += 1;
      if (idx >= spec.clientProps.length) throw new IndexErr('property id ' + idx + ' beyond the ' + spec.clientProps.length + ' own properties of ' + spec.name + ' (dynamic component)');
      const [name, t] = spec.clientProps[idx];
      out[name] = t.read(blob, pos); pos = NP;
    }
    NP = pos; return out;
  }
  // emit(ev) is called for each event, in Python's yield order; a packet's events are emitted after the whole packet is
  // decoded (Python builds the packet's list first: a later message of the packet can change an earlier event's value).
  decode(stream, emit) {
    const objects = this.objects = new ObjectTable(this.schema);
    objects.base = calibrateBase(stream, this.schema);
    let last = null, off = 0; const n = stream.length;
    const skip = this.skip;
    while (off + 12 <= n) {
      const size = U32(stream, off), ptype = U32(stream, off + 4), clock = F32(stream, off + 8);
      if (off + 12 + size > n) break;
      const p = stream.subarray(off + 12, off + 12 + size);
      off += 12 + size;
      if (clock !== last && objects.pending.length) for (const ev of objects.flush()) { if ('t' in ev) this.lastClock = ev.t; emit(ev); }
      last = clock;
      if (skip && (skip.has(ptype) || (ptype === 0x07 && this.skipProps && this.skippedProperty(p)))) {
        const e = skip.has(ptype) ? skip.get(ptype) : 1;
        if (e) { this.skipped += e; this.lastClock = clock; }
        continue;
      }
      let evs;
      try {
        if (ptype === 0x32) { evs = objects.create(p); for (const ev of evs) ev.t = clock; for (const ev of objects.retry()) evs.push(ev); }
        else if (ptype === 0x37) { const m = U32(p, 0); evs = objects.messages(slice(p, 4, 4 + m), clock); }
        else if (ptype === 0x24) evs = [this.entityNested(clock, p)];
        else if (SMALL.has(ptype)) { const ev = smallPacket(ptype, p); if (ev !== null) ev.t = clock; evs = [ev]; }
        else evs = [this.decodeOne(ptype, clock, p)];
      } catch (e) {
        evs = [{ t: clock, ev: 'undecoded', type: '0x' + (ptype < 16 ? '0' : '') + ptype.toString(16), len: p.length, error: String(e.message).slice(0, 120) }];
      }
      for (const ev of evs) {
        if (ev === null) continue;
        if (ev.ev === 'entity_create' && 'props' in ev) this.values.set(ev.id, ev.props);
        else if (ev.ev === 'property' && 'name' in ev) { let d = this.values.get(ev.id); if (!d) this.values.set(ev.id, d = {}); d[ev.name] = ev.value; }
        if ('t' in ev) this.lastClock = ev.t;
        emit(ev);
      }
    }
    this.partialBytes = n - off;
    for (const ev of objects.flush()) { if ('t' in ev) this.lastClock = ev.t; emit(ev); }
  }
  skippedProperty(p) {
    const eid = U32(p, 0), mid = U32(p, 4);
    const entity = this.entities.get(eid);
    if (entity === undefined) return false;
    let ids = this.skipIds.get(entity);
    if (!ids) {
      const spec = this.schema.spec(entity); ids = new Set();
      if (spec) spec.clientProps.forEach((m, i) => { if (this.skipProps.has(m[0])) ids.add(i); });
      this.skipIds.set(entity, ids);
    }
    return ids.has(mid);
  }
  entityNested(t, p) {
    need(p, 0, 9);
    const eid = I32(p, 0), flag = p[4], ln = U32(p, 5);
    const raw = slice(p, 9, 9 + ln).slice();
    const ent = this.entities.has(eid) ? this.entities.get(eid) : null;
    const spec = ent ? this.schema.spec(ent) : null;
    const ev = { t, ev: 'nested_property', id: eid, entity: ent };
    if (spec === null) { ev.raw = hexs(raw); return ev; }
    let values = this.values.get(eid); if (!values) this.values.set(eid, values = {});
    const holder = { props: spec.clientProps, values };
    const br = new BitReader(raw); br.read(1);
    const m = br.read(bitsFor(spec.clientProps.length));
    if (m >= spec.clientProps.length) throw new IndexErr('list index out of range');
    ev.name = spec.clientProps[m][0];
    Object.assign(ev, nestedUpdate(holder, m, flag & 1 ? 1 : 2, raw));
    return ev;
  }
  member(kind, eid, mid) {
    const ent = this.entities.has(eid) ? this.entities.get(eid) : null;
    const spec = ent ? this.schema.spec(ent) : null;
    const table = spec === null ? null : (kind === 'property' ? spec.clientProps : spec.clientMethods);
    if (table === null || mid >= table.length) return [spec, ent, null];
    return [spec, ent, table[mid]];
  }
  decodeOne(ptype, t, p) {
    const S = this.schema;
    if (ptype === 0x0a) {
      need(p, 0, 45);
      return { t, ev: 'position', id: I32(p, 0), vehicleId: I32(p, 4), pos: [F32(p, 8), F32(p, 12), F32(p, 16)],
        posError: [F32(p, 20), F32(p, 24), F32(p, 28)], yaw: F32(p, 32), pitch: F32(p, 36), roll: F32(p, 40),
        flag: view(p).getInt8(p.byteOffset + 44) };
    }
    if (ptype === 0x07 || ptype === 0x08) {
      need(p, 0, 12);
      const eid = U32(p, 0), mid = U32(p, 4), ln = U32(p, 8);
      const data = slice(p, 12, 12 + ln);
      if (ptype === 0x07) {
        const [, ent, member] = this.member('property', eid, mid);
        if (member === null) return { t, ev: 'property', id: eid, entity: ent, propId: mid, raw: hexs(data), note: 'id beyond the own properties: a dynamic component, not mapped' };
        const [pname, ty] = member;
        const val = ty.read(data, 0);
        if (NP !== data.length) throw new ValueErr('consumed');
        const ev = { t, ev: 'property', id: eid, entity: ent, name: pname, value: val };
        if (ent === 'Vehicle' && pname === 'gunAnglesPacked') { const [y, g] = decodeGunAngles(val); ev.turretYaw = y; ev.gunPitchT = g; }
        return ev;
      }
      const [, ent, member] = this.member('method', eid, mid);
      if (member === null) return { t, ev: 'method', id: eid, entity: ent, methodId: mid, raw: hexs(data), note: 'id beyond the own methods: a dynamic component, not mapped' };
      const [mname, args] = member;
      const names = S.argNames[ent + '.' + mname] || args.map((a) => a[0]);
      const out = {}; let pos = 0;
      for (let i = 0; i < args.length; i++) { out[i < names.length ? names[i] : args[i][0]] = args[i][1].read(data, pos); pos = NP; }
      if (pos !== data.length) throw new ValueErr('consumed');
      if (ent === 'Vehicle' && mname === 'showDamageFromShot') out.hitPoints = out.hitPoints.map(decodeHitPoint);
      if (ent === 'Avatar' && mname === 'updateArena') {
        const u = S.arenaUpdate[String(out.updateType)];
        out.updateTypeName = u === undefined ? null : u;
        let raw = out.argStr;
        if (raw.length && raw[0] === 0x78) { try { raw = INFLATE(raw); } catch (e) { /* zlib.error: kept */ } }
        const value = safeUnpickle(raw);
        if (value !== null) out.arg = value;
      }
      return { t, ev: 'method', id: eid, entity: ent, name: mname, args: out };
    }
    if (ptype === 0x05) {
      need(p, 0, 14);
      const eid = I32(p, 0), typ = U16(p, 4), vid = I32(p, 6), space = I32(p, 10);
      need(p, 14, 12); const pos3 = [F32(p, 14), F32(p, 18), F32(p, 22)];
      need(p, 26, 12); const dir3 = [F32(p, 26), F32(p, 30), F32(p, 34)];
      const blen = U32(p, 42);
      const blob = slice(p, 46, 46 + blen);
      const ent = this.typeName(typ);
      this.entities.set(eid, ent);
      const spec = S.spec(ent);
      const ev = { t, ev: 'entity_create', id: eid, entity: ent, typeId: typ, vehicleId: vid, spaceId: space, pos: pos3, dir: dir3 };
      if (spec === null) { ev.note = 'no .def for this entity type id (extension entity, order not derived)'; return ev; }
      try {
        const props = this.propsBlob(spec, blob); const used = NP;
        ev.props = props;
        if (used !== blob.length) throw new ValueErr('create blob consumed');
      } catch (e) {
        if (!(e instanceof IndexErr)) throw e;
        ev.note = e.message;
      }
      return ev;
    }
    if (ptype === 0x06) {
      need(p, 0, 8);
      const eid = I32(p, 0), blen = U32(p, 4);
      const ent = this.entities.get(eid) || 'Vehicle';
      const spec = S.spec(ent); if (spec === null) throw new Error('NoneType');
      const props = this.propsBlob(spec, slice(p, 8, 8 + blen));
      if (NP !== blen) throw new ValueErr('0x06 consumed');
      return { t, ev: 'entity_properties', id: eid, entity: ent, props };
    }
    if (ptype === 0x00) {
      need(p, 0, 14);
      const eid = I32(p, 0), typ = U16(p, 4), blen = U32(p, 10);
      const ent = this.typeName(typ);
      this.entities.set(eid, ent); this.playerId = eid;
      const blob = slice(p, 14, 14 + blen);
      const spec = S.spec(ent); if (spec === null) throw new Error('NoneType');
      const out = {}; let pos = 0;
      for (const [n_, ty, fl] of spec.props) if (fl === 'BASE_AND_CLIENT') { out[n_] = ty.read(blob, pos); pos = NP; }
      return { t, ev: 'player_base', id: eid, entity: ent, props: out, note: 'BASE_AND_CLIENT properties in declaration order; ' + (blob.length - pos) + ' trailing byte(s)' };
    }
    if (ptype === 0x01) {
      need(p, 0, 14);
      const eid = I32(p, 0), space = I32(p, 4), vid = I32(p, 10);
      need(p, 14, 12); const pos3 = [F32(p, 14), F32(p, 18), F32(p, 22)];
      need(p, 26, 12); const dir3 = [F32(p, 26), F32(p, 30), F32(p, 34)];
      const blen = U32(p, 38);
      const blob = slice(p, 42, 42 + blen);
      const ent = this.entities.has(eid) ? this.entities.get(eid) : 'Avatar';
      const spec = S.spec(ent); if (spec === null) throw new Error('NoneType');
      const out = {}; let pos = 0;
      for (const [n_, ty, fl] of spec.props) if (CELL_CLIENT_FLAGS.has(fl)) { out[n_] = ty.read(blob, pos); pos = NP; }
      return { t, ev: 'player_cell', id: eid, spaceId: space, vehicleId: vid, pos: pos3, dir: dir3, props: out,
        note: 'own cell properties decoded; ' + (blob.length - pos) + ' byte(s) of dynamic components not decoded' };
    }
    if (ptype === 0x03 || ptype === 0x04) return { t, ev: ptype === 0x04 ? 'entity_leave' : 'entity_enter', id: I32(p, 0) };
    if (ptype === 0x18 || ptype === 0x1b) {
      const n = U32(p, 0); const ev = { t, ev: S.packetNames[String(ptype)] };
      ev[ptype === 0x18 ? 'version' : 'mode'] = ascii(slice(p, 4, 4 + n)); return ev;
    }
    if (ptype === 0x0f) {
      need(p, 0, 8); const n = U32(p, 4); const s = slice(p, 8, 8 + n); let z = s.indexOf(0); if (z < 0) z = s.length;
      return { t, ev: 'space_data', space: ascii(s.subarray(0, z)) };
    }
    if (ptype === 0x23) return { t, ev: 'chat_message', len: p.length };
    if (ptype === 0x31) {
      const n = U32(p, 0); const name = ascii(slice(p, 4, 4 + n));
      const m = U32(p, 4 + n);
      const ev = { t, ev: 'named_event', name };
      if (!name.startsWith('bw_chat2')) ev.args = safeUnpickle(slice(p, 8 + n, 8 + n + m));
      return ev;
    }
    if (ptype === 0x32) return { t, ev: 'cgf_replication', len: p.length, note: 'not decoded' };
    if (ptype === 0xffffffff) return { t, ev: 'end', len: p.length };
    return { t, ev: 'packet', type: '0x' + (ptype < 16 ? '0' : '') + ptype.toString(16), len: p.length, raw: hexs(slice(p, 0, 64)) };
  }
}

// ---- Blowfish of the final file -----------------------------------------------------------------------------------------
function piWords(count) {
  const arctanInv = (x, one) => { let total = one / x, term = total; const x2 = x * x; let n = 1n, sign = -1n;
    while (term) { term /= x2; n += 2n; total += sign * (term / n); sign = -sign; } return total; };
  const bits = BigInt(count * 32 + 64);
  const one = 1n << (bits + 32n);
  const pi = 4n * (4n * arctanInv(5n, one) - arctanInv(239n, one));
  const frac = (pi >> 32n) - (3n << bits);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = Number((frac >> (bits - 32n * BigInt(i + 1))) & 0xffffffffn);
  return out;
}
const REPLAY_KEY = Uint8Array.from([0xDE, 0x72, 0xBE, 0xA0, 0xDE, 0x04, 0xBE, 0xB1, 0xDE, 0xFE, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF]);
function blowfishSchedule(key) {
  const words = piWords(18 + 4 * 256);
  const P = words.slice(0, 18), S = new Uint32Array(1024); S.set(words.subarray(18));
  for (let i = 0; i < 18; i++) { let k = 0; for (let j = 0; j < 4; j++) k = ((k << 8) | key[(i * 4 + j) % key.length]) >>> 0; P[i] = (P[i] ^ k) >>> 0; }
  const F = (l) => ((((S[l >>> 24] + S[256 | ((l >>> 16) & 255)]) >>> 0) ^ S[512 | ((l >>> 8) & 255)]) + S[768 | (l & 255)]) >>> 0;
  let l = 0, r = 0;
  const enc = () => { for (let i = 0; i < 16; i++) { l = (l ^ P[i]) >>> 0; r = (r ^ F(l)) >>> 0; const t = l; l = r; r = t; }
    const t = l; l = r; r = t; r = (r ^ P[16]) >>> 0; l = (l ^ P[17]) >>> 0; };
  for (let i = 0; i < 18; i += 2) { enc(); P[i] = l; P[i + 1] = r; }
  for (let i = 0; i < 1024; i += 2) { enc(); S[i] = l; S[i + 1] = r; }
  return { P, S };
}
function decryptStream(data, sched) {
  const { P, S } = sched;
  const n = data.length >> 3; const out = new Uint8Array(n * 8);
  const din = new DataView(data.buffer, data.byteOffset, n * 8), dout = new DataView(out.buffer);
  let pl = 0, pr = 0; const p0 = P[0], p1 = P[1];
  for (let b = 0; b < n; b++) {
    let l = din.getUint32(8 * b, false), r = din.getUint32(8 * b + 4, false);
    for (let k = 17; k > 1; k--) {
      l ^= P[k];
      r ^= ((((S[l >>> 24] + S[256 | ((l >>> 16) & 255)]) | 0) ^ S[512 | ((l >>> 8) & 255)]) + S[768 | (l & 255)]) | 0;
      const t = l; l = r; r = t;
    }
    pl ^= r ^ p0; pr ^= l ^ p1;   // the last swap undone: (l, r) = (r, l)
    dout.setUint32(8 * b, pl >>> 0, false); dout.setUint32(8 * b + 4, pr >>> 0, false);
  }
  return out;
}

function setInflate(fn) { INFLATE = fn; }
const ReplayDecoder = { Schema, Decoder, canonEvent, canon, setInflate, blowfishSchedule, decryptStream, REPLAY_KEY, decodeGunAngles };
if (typeof module !== 'undefined' && module.exports) module.exports = ReplayDecoder; else self.ReplayDecoder = ReplayDecoder;
