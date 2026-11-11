#!/usr/bin/env python3
"""Register the stateless Compare service. Run as root; preserves existing inventory entries."""
import json
import os
import pathlib
import tempfile
import sys


def entry():
    return {
        '_note': 'Compare v1: stateless, sourced public comparisons; no database or service credentials.',
        'repo': '/opt/openvibe.compare',
        'origin': 'https://openvibe.compare',
        'units': ['openvibe-compare.service'],
        'unitSources': {'openvibe-compare.service': 'deploy/systemd/openvibe-compare.service'},
        'installUnits': True,
        'envFile': '/etc/openvibe/compare.env',
        'env': {'required': ['PORT', 'HOST', 'BASE_URL']},
        'port': 5280,
        'ready': {'url': 'http://127.0.0.1:5280/api/ready', 'timeoutSeconds': 30},
        'databases': [],
        'nginx': {'vhost': 'openvibe.compare.conf', 'repoVhost': 'deploy/nginx/openvibe.compare.conf', 'variant': 'http'},
        'lifecycle': {
            'liveness': {'endpoint': '/api/health', 'means': 'HTTP process answers'},
            'shutdown': {'signal': 'SIGTERM', 'deadlineSeconds': 10, 'drains': ['HTTP server closed']},
            'startupRecovery': {'resumes': [{'kind': 'state', 'what': 'Refetch public sources after ten-minute cache reset'}]},
            'rollback': {'conditions': ['Ready probe fails'], 'window': 'Any time', 'blockers': {'none': 'Stateless; no migrations'}},
            'leases': {'none': 'No workers or writes'},
        },
    }


def register(target):
    target = pathlib.Path(target)
    data = json.loads(target.read_text())
    if 'compare' in data['services']:
        if data['services']['compare'] != entry():
            raise SystemExit('compare already registered with different settings; refusing overwrite')
        print('compare already registered')
        return
    for name, service in data['services'].items():
        if service.get('port') == 5280 or service.get('drill', {}).get('port') == 5280:
            raise SystemExit(f'Port 5280 already belongs to {name}')
    data['services']['compare'] = entry()
    st = target.stat()
    fd, tmp = tempfile.mkstemp(prefix='.compare-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out, indent=2)
            out.write('\n')
        os.chmod(tmp, st.st_mode & 0o777)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print('compare registered on port 5280; no database')


if __name__ == '__main__':
    register(sys.argv[1] if len(sys.argv) > 1 else '/etc/openvibe/host.json')
