#!/usr/bin/env python3
"""Register the stateless Directory service. Run as root; preserves existing inventory entries."""
import json
import os
import pathlib
import tempfile
import sys


def old_entry():
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


def entry():
    service = old_entry()
    service['_note'] = 'Directory: sourced public reads plus opt-in people listings in PostgreSQL.'
    service['databases'] = [{'name': 'directory', 'engine': 'postgresql', 'database': 'ov_directory'}]
    service['env'] = {'required': ['PORT', 'HOST', 'BASE_URL', 'DATABASE_URL', 'OV_OAUTH_CLIENT_ID', 'OV_OAUTH_CLIENT_SECRET']}
    service['lifecycle']['startupRecovery']['resumes'].append({'kind': 'state', 'what': 'Reload opt-in people listings from PostgreSQL.'})
    service['lifecycle']['rollback']['blockers'] = {'none': 'People migration is expand-only and the previous version ignores the new table.'}
    service['lifecycle']['contracts'] = {'none': 'Directory uses signed Network user tokens and its own PostgreSQL table; the service manifest release is separate.'}
    service['lifecycle']['leases'] = {'none': 'No background writer lease; public source refresh stays in process.'}
    return service


def register(target):
    target = pathlib.Path(target)
    data = json.loads(target.read_text())
    if 'directory' in data['services']:
        if data['services']['directory'] == entry():
            print('directory already registered')
            return
        if data['services']['directory'] != old_entry():
            raise SystemExit('directory already registered with different settings; refusing overwrite')
        data['services']['directory'] = entry()
    for name, service in data['services'].items():
        if name != 'directory' and (service.get('port') == 5281 or service.get('drill', {}).get('port') == 5281):
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
