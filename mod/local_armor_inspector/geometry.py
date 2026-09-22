"""Extract the shot-collision system, excluding vehicle physics and triggers."""
import math
from .havok import TagFile, FormatError


def unpack_vertex(value, base, scale, bits=(11, 11, 10)):
    result = []
    for i, width in enumerate(bits):
        result.append(base[i] + (value & ((1 << width)-1)) * scale[i])
        value >>= width
    return result


def compressed_mesh(shape):
    tree = shape['data']['meshTree']
    lo, hi = tree['domain']['min'], tree['domain']['max']
    shared = [unpack_vertex(v, lo, [(hi[i]-lo[i])/((1 << bits)-1) for i, bits in enumerate((21,21,22))], (21,21,22)) for v in tree['sharedVertices']]
    vertices, indices = [], []
    for section in tree['sections']:
        start, count = section['firstPackedVertexIndex'], section['numPackedVertices']
        codec = section['codecParms']
        local = [unpack_vertex(v, codec[:3], codec[3:]) for v in tree['packedVertices'][start:start+count]]
        first = section['firstPrimitiveIndex']
        primitives = tree['primitives'][first:first+section['numPrimitives']]
        # Padding primitives can contain 0xDEADDEAD. They form no triangle.
        primitives = [p for p in primitives if len(set(p['indices'][:3])) == 3 or len({p['indices'][0],p['indices'][2],p['indices'][3]}) == 3]
        largest = max([max(p['indices']) for p in primitives] or [-1])
        for i in range(count, largest+1):
            shared_index = tree['sharedVerticesIndex'][section['firstSharedVertexIndex']+i-count]
            local.append(shared[shared_index])
        offset = len(vertices)
        for v in local:
            if not all(not math.isnan(x) and not math.isinf(x) and lo[i]-0.02 <= x <= hi[i]+0.02 for i, x in enumerate(v)):
                raise FormatError('Decoded vertex outside collision bounds')
        vertices.extend(local)
        for p in primitives:
            a,b,c,d = p['indices']
            if len({a,b,c}) == 3: indices.extend([offset+a,offset+b,offset+c])
            if d != c and len({a,c,d}) == 3: indices.extend([offset+a,offset+c,offset+d])
    return vertices, indices


def transform(v, position, quaternion):
    x,y,z,w = quaternion
    tx,ty,tz = 2*(y*v[2]-z*v[1]), 2*(z*v[0]-x*v[2]), 2*(x*v[1]-y*v[0])
    return [v[0]+w*tx+y*tz-z*ty+position[0], v[1]+w*ty+z*tx-x*tz+position[1], v[2]+w*tz+x*ty-y*tx+position[2]]


def extract(data):
    root = TagFile(data).root
    systems = root['namedVariants'][0]['variant']['resourceHandles']
    system = next((h['variant'] for h in systems if h['name']=='Collision Physics Data'), None)
    if system is None: raise FormatError('Shot collision system not found')
    groups = []
    for body in system['bodyCinfos']:
        shape = body['shape']
        if shape['__type'] != 'hknpCompressedMeshShape':
            raise FormatError('Unsupported collision shape: ' + shape['__type'])
        vertices, indices = compressed_mesh(shape)
        # Rounded to 1e-6 m (half a micron at most) once placed in the body: the full repr of
        # a double was ~20 bytes a coordinate, 41 % smaller files. Shared vertices stay equal.
        # Only models extracted from now on are affected: files already in data/models are
        # never rewritten, and the model key and the resource's sha256 do not change.
        vertices = [[round(c, 6) for c in transform(v, body['position'], body['orientation'])]
                    for v in vertices]
        name = body['name']
        groups.append({'material':name[2:] if name.startswith('s_') else name, 'vertices':vertices, 'indices':indices})
    if not groups: raise FormatError('Empty shot collision model')
    return {'kind':'client-shot-collision', 'groups':groups}
