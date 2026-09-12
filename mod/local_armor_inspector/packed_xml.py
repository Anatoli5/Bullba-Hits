"""Read BigWorld packed XML (layout also documented in Smellyriver TankInspector)."""
import base64
import struct
import xml.etree.ElementTree as ET


def signed_integer(raw):
    if not raw: return 0
    n = sum(v << (8*i) for i,v in enumerate(bytearray(raw)))
    return n-(1 << (8*len(raw))) if bytearray(raw)[-1] & 128 else n


def decode(data):
    if not data.startswith(b'EN\xa1b\0'): return ET.fromstring(data)
    names, pos = [], 5
    while True:
        end = data.index(b'\0',pos)
        if end==pos:
            pos += 1
            break
        names.append(data[pos:end].decode('utf-8')); pos=end+1

    def value(element, kind, a, b, depth):
        if b<a or b>len(data) or depth>100: raise ValueError('Invalid packed XML bounds')
        raw=data[a:b]
        if kind==0: section(element,a,b,depth+1)
        elif kind==1: element.text=raw.decode('utf-8')
        elif kind==2: element.text=str(signed_integer(raw))
        elif kind==3: element.text=' '.join(str(struct.unpack_from('<f',raw,i)[0]) for i in range(0,len(raw),4))
        elif kind==4: element.text='true' if raw else 'false'
        elif kind==5: element.text=base64.b64encode(raw).decode('ascii')
        else: raise ValueError('Unknown packed XML value')

    def section(element,a,b,depth):
        count, own=struct.unpack_from('<HI',data,a)
        header=a+6+count*6
        if header>b: raise ValueError('Invalid packed XML header')
        descriptors=[struct.unpack_from('<HI',data,a+6+i*6) for i in range(count)]
        offset=own&0xfffffff
        value(element,own>>28,header,header+offset,depth)
        for name,word in descriptors:
            end=word&0xfffffff
            child=ET.SubElement(element,names[name])
            value(child,word>>28,header+offset,header+end,depth)
            offset=end
    root=ET.Element('root')
    section(root,pos,len(data),0)
    return root
