"""Query the project's list of open work (docs/BACKLOG.md, its status table) instead of scrolling it.

python tools/backlog.py                      open rows: number, priority, area, status, the task's bold title
python tools/backlog.py --area "3D viewer"   rows whose area holds the text (case-insensitive substring)
  --priority A   --status <text>   --all (closed rows too)   --full (the whole row)

A row is closed when its status starts with one of CLOSED_PREFIXES. A row the reader cannot parse is an error naming
its number (exit 2). docs/ is local agent context: on a clean clone the file is absent (exit 1).
"""
import argparse
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKLOG = os.path.join(ROOT, 'docs', 'BACKLOG.md')
HEADER = '| № | Задача | Приор. | Область | Статус | Материалы | Следующий шаг |'
COLUMNS = ('num', 'task', 'priority', 'area', 'status', 'materials', 'next')
PRIORITIES = ('A', 'B', 'C')
CLOSED_PREFIXES = ('сделано (', 'выпущено', 'закрыто', 'отменено')
BOLD = re.compile(r'\*\*(.+?)\*\*')


class BacklogError(Exception):
    pass


def is_closed(status):
    return status.strip('* ').startswith(CLOSED_PREFIXES)


def title(task, width=110):
    """The bold title of a task, or its start when it has none."""
    match = BOLD.match(task)
    text = match.group(1) if match else task
    return text if len(text) <= width else text[:width - 1] + '…'


def read_rows(path=BACKLOG):
    """The status table's rows as dicts, in file order."""
    with io.open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    try:
        start = lines.index(HEADER) + 2
    except ValueError:
        raise BacklogError('status table header not found: %s' % HEADER)
    rows = []
    for line in lines[start:]:
        if not line.startswith('| '):
            break
        cells = [c.strip() for c in line.strip()[2:-2].split(' | ')]
        num = cells[0] if cells else '?'
        if len(cells) != len(COLUMNS) or not line.strip().endswith(' |'):
            raise BacklogError('row %s: %d cells, expected %d' % (num, len(cells), len(COLUMNS)))
        row = dict(zip(COLUMNS, cells))
        if row['priority'] not in PRIORITIES:
            raise BacklogError('row %s: priority %r is not one of A/B/C' % (num, row['priority']))
        if not row['area'] or not row['status']:
            raise BacklogError('row %s: empty area or status' % num)
        row['closed'] = is_closed(row['status'])
        rows.append(row)
    return rows


def select(rows, area=None, priority=None, status=None, include_closed=False):
    out = []
    for row in rows:
        if row['closed'] and not include_closed:
            continue
        if area and area.lower() not in row['area'].lower():
            continue
        if priority and row['priority'] != priority.upper():
            continue
        if status and status.lower() not in row['status'].lower():
            continue
        out.append(row)
    return out


def short(row):
    status = row['status'].replace('**', '')
    if len(status) > 50:
        status = status[:49] + '…'
    return '%-4s %s  [%s]  {%s}  %s' % (row['num'], row['priority'], row['area'], status, title(row['task']))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Query docs/BACKLOG.md (open rows by default).')
    parser.add_argument('--area', help='substring of the area column (a block name of docs/MAP.md, or проект)')
    parser.add_argument('--priority', choices=['A', 'B', 'C', 'a', 'b', 'c'])
    parser.add_argument('--status', help='substring of the status')
    parser.add_argument('--all', action='store_true', help='closed rows too')
    parser.add_argument('--full', action='store_true', help='print the whole row')
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if not os.path.isfile(BACKLOG):
        print('docs/BACKLOG.md is absent (local agent context, not in git)', file=sys.stderr)
        return 1
    try:
        rows = read_rows()
    except BacklogError as e:
        print('backlog: %s' % e, file=sys.stderr)
        return 2
    chosen = select(rows, args.area, args.priority, args.status, args.all)
    for row in chosen:
        if args.full:
            print('| ' + ' | '.join(row[c] for c in COLUMNS) + ' |')
        else:
            print(short(row) + ('  (closed)' if row['closed'] else ''))
    print('-- %d of %d rows' % (len(chosen), len(rows)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
