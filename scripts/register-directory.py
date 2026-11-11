#!/usr/bin/env python3
"""Register the stateless Directory service. Run as root; preserves existing inventory entries."""
import json
import os
import pathlib
import tempfile
import sys


def entry():
    return {
        '_note': 'Directory v1: stateless, source-linked public directories; no database or service credentials.',
        'repo': '/opt/openvibe.directory',
        'origin': 'https://openvibe.directory',
        'units': ['openvibe-directory.service'],
        'unitSources': {'openvibe-directory.service': 'deploy/systemd/openvibe-directory.service'},
        'installUnits': True,
        'envFile': '/etc/openvibe/directory.env',
        'env': {'required': ['PORT', 'HOST', 'BASE_URL']},
        'port': 5281,
        'ready': {'url': 'http://127.0.0.1:5281/api/ready', 'timeoutSeconds': 30},
        'databases': [],
        'nginx': {'vhost': 'openvibe.directory.conf', 'repoVhost': 'deploy/nginx/openvibe.directory.conf', 'variant': 'http'},
        'lifecycle': {
            'liveness': {'endpoint': '/api/health', 'means': 'HTTP process answers'},
            'shutdown': {'signal': 'SIGTERM', 'deadlineSeconds': 10, 'drains': ['HTTP server closed']},
            'startupRecovery': {'resumes': [{'kind': 'state', 'what': 'Refetch public sources after six-hour cache reset'}]},
            'rollback': {'conditions': ['Ready probe fails'], 'window': 'Any time', 'blockers': {'none': 'Stateless; no migrations'}},
            'contracts': {'none': 'Stateless public reads; no runtime Contracts dependency. Directory schema release is held separately.'},
            'leases': {'none': 'No workers or writes'},
        },
    }


def register(target):
    target = pathlib.Path(target)
    data = json.loads(target.read_text())
    if 'directory' in data['services']:
        if data['services']['directory'] != entry():
            raise SystemExit('directory already registered with different settings; refusing overwrite')
        print('directory already registered')
        return
    for name, service in data['services'].items():
        if service.get('port') == 5281 or service.get('drill', {}).get('port') == 5281:
            raise SystemExit(f'Port 5281 already belongs to {name}')
    data['services']['directory'] = entry()
    st = target.stat()
    fd, tmp = tempfile.mkstemp(prefix='.directory-', dir=target.parent)
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
    print('directory registered on port 5281; no database')


if __name__ == '__main__':
    register(sys.argv[1] if len(sys.argv) > 1 else '/etc/openvibe/host.json')
