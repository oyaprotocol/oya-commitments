#!/usr/bin/env python3
"""Offline upgrade acceptance tests. Fake Docker is a real child process.

No live Docker calls, Keychain access, release publication, or transactions.
The fake engine persists container/volume/checkpoint state between subprocesses.
"""
import argparse
import contextlib
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('upgrade_node', ROOT / 'scripts/upgrade-node.py')
assert SPEC is not None and SPEC.loader is not None
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)
OLD = upgrade.IMAGE_REPOSITORY + '@sha256:' + '1' * 64
NEW = upgrade.IMAGE_REPOSITORY + '@sha256:' + '2' * 64
CONFIG = 'sha256:' + '3' * 64
COMMIT = '4' * 40
RELEASE = 'node-v0.4.0'
LABELS = {'org.opencontainers.image.' + k: v for k, v in {
    'source': upgrade.SOURCE, 'revision': COMMIT, 'version': 'v0.4.0'}.items()}

# Deliberately independent subprocess implementation, not a mock of apply_upgrade.
DOCKER = r'''#!/usr/bin/env python3
import copy,json,os,sys
from pathlib import Path
p=Path(os.environ['FAKE_ENGINE'])
s=json.loads(p.read_text()); a=sys.argv[1:]
s['events'].append({'args':a,'context':os.environ.get('DOCKER_CONTEXT'),
 'files':os.environ.get('COMPOSE_FILE'),'custom':os.environ.get('CUSTOM_OVERRIDE')})
def save(): p.write_text(json.dumps(s))
def finish(value=None):
 save()
 if value is not None: print(value if isinstance(value,str) else json.dumps(value))
 sys.exit(0)
def fail():
 save(); print('SENSITIVE_CHILD_OUTPUT',file=sys.stderr);sys.exit(7)
def matches(key):
 prefix=s.get(key)
 return prefix and a[:len(prefix)]==prefix
if matches('fail_before'): fail()
def model():
 m=copy.deepcopy(s['model']); old=s['old_bundle'];new=os.environ['OYA_BUNDLE_DIR']
 def remap(v):
  if isinstance(v,str): return new+v[len(old):] if v.startswith(old+'/') else v
  if isinstance(v,list): return [remap(x) for x in v]
  if isinstance(v,dict): return {k:remap(x) for k,x in v.items()}
  return v
 m=remap(m);m['services'][s['selected']]['image']=os.environ['OYA_NODE_IMAGE']
 if s.get('drift') and os.environ['OYA_NODE_IMAGE']!=s['old_image']:
  m['services'][s['selected']]['volumes'][0]['source']+='.changed'
 if os.environ.get('OYA_WORKER_SECRET_FILE'):
  node=m['services']['node'];node['restart']='no'
  for v in node['volumes']:
   if v['target']=='/run/secrets/worker.json': v['source']=os.environ['OYA_WORKER_SECRET_FILE']
 return m
def container(name,m):
 svc=m['services'][name]
 mounts=[]
 for v in svc.get('volumes',[]):
  d={'Type':v['type'],'Destination':v['target'],'RW':not v.get('read_only',False)}
  if v['type']=='volume':d.update(Name=m['volumes'][v['source']]['name'],Source='/var/lib/docker/volumes/x')
  else:d['Source']=v['source']
  mounts.append(d)
 return {'Id':name+'-id','Image':s['config_digest'],
  'Config':{'Image':svc['image'],'Entrypoint':svc.get('entrypoint'),'Cmd':svc.get('command'),
   'User':svc.get('user'),'Labels':{'com.docker.compose.service':name,'com.docker.compose.oneoff':'False'}},
  'HostConfig':{'RestartPolicy':{'Name':svc.get('restart','no')}},'Mounts':mounts,
  'State':{'Running':True,'Restarting':False,'ExitCode':0,'Health':{'Status':'healthy'}}}
if a==['context','show']:finish(s.get('context','fixture'))
if a[:2]==['context','inspect']:finish([{'Endpoints':{'docker':{'Host':'unix:///fixture.sock'}}}])
if a[:2]==['ps','-aq']:finish('\n'.join(c['Id'] for c in s['containers'].values()))
if a[0]=='inspect':
 ids=a[1:]
 finish([c for c in s['containers'].values() if c['Id'] in ids])
if a[:2]==['volume','inspect']:finish([{'Name':a[2],'Driver':'local','Options':None}])
if a[:2]==['info','--format']:finish({'OSType':'linux','Architecture':'x86_64','OperatingSystem':s.get('os','Fixture Linux')})
if a[:2]==['image','inspect']:
 finish([{'Id':s['config_digest'],'RepoDigests':[s['new_image']],'Os':'linux','Architecture':s.get('image_arch','amd64'),'Config':{'Labels':s['labels']}}])
if a[0]=='pull':finish()
if a[:2]==['compose','config']:
 if '--quiet' in a:finish()
 finish(model())
if a[:2]==['compose','ps']:
 name=a[-1];finish(s['containers'].get(name,{}).get('Id',''))
if a[:2]==['compose','stop']:
 if a[-1] in s['containers']:s['containers'][a[-1]]['State']['Running']=False
 if matches('fail_after'):fail()
 finish()
if a[:2]==['compose','rm']:
 s['containers'].pop(a[-1],None);finish()
if a[:2]==['compose','up']:
 assert '--no-deps' in a and '--no-build' in a and '--pull' in a and a[a.index('--pull')+1]=='never'
 name=a[-1];s['containers'][name]=container(name,model())
 if s.get('unhealthy'):s['containers'][name]['State']['Health']['Status']='unhealthy'
 if matches('fail_after'):fail()
 finish()
if a[:4]==['compose','exec','-T','postgres']:
 if a[4]=='pg_dump':
  save();sys.stdout.buffer.write(b'PGDMP'+s['checkpoint'].encode());sys.exit(0)
 if a[4]=='pg_restore':
  assert sys.stdin.buffer.read().startswith(b'PGDMP');finish()
raise AssertionError(a)
'''


def archive(files=None, extra=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.USTAR_FORMAT) as tar:
        for name, data in (files or {'node/production/image.txt': (NEW + '\n').encode()}).items():
            member = tarfile.TarInfo('./' + name)
            member.size = len(data)
            member.mode = 0o644
            tar.addfile(member, io.BytesIO(data))
        if extra:
            tar.addfile(extra, io.BytesIO(b'x' * extra.size) if extra.isfile() else None)
    return output.getvalue()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='oya-upgrade-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.private = self.root / 'private installation'
        self.private.mkdir(mode=0o700)
        self.bundle = self.root / 'old release'
        self.bundle.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'docker').write_text(DOCKER)
        (self.bin / 'docker').chmod(0o755)
        self.state_path = self.root / 'engine.json'
        self.role = 'worker'
        self.configure('worker')
        self.environment = {'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                            'HOME': str(self.root), 'FAKE_ENGINE': str(self.state_path)}
        self.env_patch = patch.dict(os.environ, self.environment, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.addCleanup(patch.stopall)
        patch.object(upgrade, 'release_assets', side_effect=self.release).start()
        patch.object(upgrade, 'registry_identity', return_value=CONFIG).start()
        self.output = io.StringIO()
        self.stdout_patch = contextlib.redirect_stdout(self.output)
        self.stdout_patch.__enter__()
        self.addCleanup(self.stdout_patch.__exit__, None, None, None)

    def put(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode() if isinstance(content, str) else content)
        path.chmod(0o600)

    def configure(self, role, keychain=False):
        self.role = role
        for rel in upgrade.PUBLIC_FILES:
            self.put(self.bundle / rel, '# fixture public asset\n')
        self.put(self.bundle / 'node/production/image.txt', OLD + '\n')
        self.put(self.bundle / 'node/production/scripts/keychain-worker.py', (ROOT / 'scripts/keychain-worker.py').read_bytes())
        config = {'mode': 'ipfs'} if role == 'worker' else {'execution': {'mode': 'ipfs'}}
        names = ['node.json', 'node.env', 'worker.json', 'worker-secrets.json'] if role == 'worker' else ['inbox.json', 'inbox-secrets.json', 'postgres-password']
        for name in names:
            self.put(self.private / name, json.dumps(config) if name in ['node.json', 'inbox.json'] else 'SENSITIVE_CONFIG_KEEP_BYTE_FOR_BYTE\n')
        if role == 'inbox':
            self.put(self.private / 'inbox-secrets.json', json.dumps({'databaseUrl': 'postgresql://oya:FIXTURE_PASSWORD@postgres:5432/oya'}))
        selected = 'node' if role == 'worker' else 'inbox'
        def bind(name, target):
            return {'type': 'bind', 'source': str(self.private / name), 'target': target, 'read_only': True,
                    'bind': {'create_host_path': False}}
        volumes = [bind('node.json', '/config/node.json'), bind('node.env', '/run/secrets/node.env'),
                   bind('worker.json', '/config/worker.json'), bind('worker-secrets.json', '/run/secrets/worker.json')] if role == 'worker' else [bind('inbox.json', '/config/inbox.json'), bind('inbox-secrets.json', '/run/secrets/inbox.json')]
        dependency = 'ipfs' if role == 'worker' else 'postgres'
        volume = dependency + '-data'
        service = {'image': OLD, 'user': '501:20', 'platform': 'linux/amd64',
                   'entrypoint': ['node', '/app/src/inbox/' + ('worker.mjs' if role == 'worker' else 'main.mjs')],
                   'command': [v['target'] for v in volumes], 'volumes': volumes,
                   'healthcheck': {'test': ['CMD', 'fixture-health']}, 'restart': 'unless-stopped',
                   'depends_on': {dependency: {'condition': 'service_healthy', 'required': True}}}
        dep = {'image': 'fixture-dependency@sha256:' + '5' * 64, 'restart': 'unless-stopped',
               'healthcheck': {'test': ['CMD', 'fixture-health']},
               'volumes': [{'type': 'volume', 'source': volume, 'target': '/data'}]}
        if role == 'inbox':
            dep['volumes'].append(bind('postgres-password', '/run/secrets/postgres-password'))
            dep['environment'] = {'POSTGRES_USER': 'oya', 'POSTGRES_DB': 'oya'}
        model = {'name': 'fixture_project', 'services': {selected: service, dependency: dep},
                 'volumes': {volume: {'name': 'fixture_project_' + volume}}}
        paths = [self.bundle / ('node/production/inbox/compose.worker.yaml' if role == 'worker' else 'node/production/inbox/compose.yaml')]
        if role == 'inbox':
            paths.append(self.bundle / 'node/production/inbox/compose.postgres.yaml')
        override = self.private / 'platform.yaml'
        self.put(override, 'services: {}\n')
        paths.append(override)
        if keychain:
            runtime = self.private / '.keychain-runtime'
            runtime.mkdir(mode=0o700, exist_ok=True)
            service['restart'] = 'no'
            volumes[-1]['source'] = str(runtime / 'worker.json')
        self.env_file = self.private / 'compose.env'
        saved = {'OYA_BUNDLE_DIR': str(self.bundle), 'OYA_NODE_IMAGE': OLD,
                 'OYA_LOCAL_DIR' if role == 'worker' else 'OYA_INBOX_DIR': str(self.private),
                 'OYA_CONTAINER_USER': '501:20', 'OYA_NODE_PLATFORM': 'linux/amd64',
                 'COMPOSE_PROJECT_NAME': 'fixture_project', 'COMPOSE_FILE': ':'.join(map(str, paths)),
                 'DOCKER_CONTEXT': 'fixture', 'CUSTOM_OVERRIDE': 'literal value = unchanged'}
        text = '# preserve this comment and all unrelated exports\n' + ''.join('export ' + key + '=' + shlex.quote(value) + '\n' for key, value in saved.items())
        self.put(self.env_file, text)
        containers = {}
        for name, svc in model['services'].items():
            mounts = []
            for v in svc.get('volumes', []):
                mount = {'Type': v['type'], 'Destination': v['target'], 'RW': not v.get('read_only', False)}
                if v['type'] == 'volume':
                    mount.update(Name=model['volumes'][v['source']]['name'], Source='/var/lib/docker/volumes/fixture')
                else:
                    mount['Source'] = v['source']
                mounts.append(mount)
            containers[name] = {'Id': name + '-id', 'Image': 'sha256:' + '6' * 64,
                                'Config': {'Image': svc['image'], 'Entrypoint': svc.get('entrypoint'), 'Cmd': svc.get('command'),
                                           'User': svc.get('user'), 'Labels': {'com.docker.compose.service': name, 'com.docker.compose.oneoff': 'False'}},
                                'HostConfig': {'RestartPolicy': {'Name': svc.get('restart', 'no')}}, 'Mounts': mounts,
                                'State': {'Running': True, 'Restarting': False, 'ExitCode': 0, 'Health': {'Status': 'healthy'}}}
        self.state = {'events': [], 'model': model, 'containers': containers, 'old_bundle': str(self.bundle),
                      'old_image': OLD, 'new_image': NEW, 'selected': selected, 'config_digest': CONFIG, 'labels': LABELS,
                      'checkpoint': 'EXISTING_NONCE_SIGNED_BYTES_AND_JOB_ID_UNCHANGED'}
        self.save_state()

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state))

    def read_state(self):
        return json.loads(self.state_path.read_text())

    def release(self, tag, destination):
        bundle = destination / 'bundle'
        shutil_copy(self.bundle, bundle)
        self.put(bundle / 'node/production/image.txt', NEW + '\n')
        return {'tag': tag, 'image': NEW, 'commit': COMMIT, 'archive_sha256': 'a' * 64, 'bundle': str(bundle)}

    def args(self, action='preview', **kwargs):
        return argparse.Namespace(action=action, role=self.role, env_file=str(self.env_file),
                                  release=None if action == 'quiesce' else RELEASE,
                                  workers_stopped=kwargs.get('workers_stopped', False),
                                  inbox_ready=kwargs.get('inbox_ready'),
                                  keychain_account=kwargs.get('keychain_account'), keychain_service=kwargs.get('keychain_service'))

    def run_upgrade(self, action='preview', **kwargs):
        upgrade.run(self.args(action, **kwargs))

    def mutations(self):
        return [e['args'] for e in self.read_state()['events'] if e['args'][0] == 'pull' or e['args'][:2] in
                [['compose', 'up'], ['compose', 'stop'], ['compose', 'rm'], ['compose', 'exec']]]

    def test_preview_has_zero_mutations_and_preserves_all_files(self):
        before = {p: p.read_bytes() for p in self.private.iterdir() if p.is_file()}
        self.run_upgrade()
        self.assertEqual(self.mutations(), [])
        self.assertFalse((self.private / '.oya-upgrades').exists())
        self.assertEqual(before, {p: p.read_bytes() for p in self.private.iterdir() if p.is_file()})
        self.assertNotIn('SENSITIVE', self.output.getvalue())

    def test_null_compose_fields_inherit_image_command_and_user(self):
        for role, dependency in [('worker', 'ipfs'), ('inbox', 'postgres')]:
            with self.subTest(role=role):
                self.configure(role)
                # Real Compose JSON includes null for unspecified image defaults.
                self.state['model']['services'][dependency].update(entrypoint=None, command=None, user=None)
                self.state['containers'][dependency]['Config'].update(
                    Entrypoint=['image-entrypoint'], Cmd=['image-command'], User='image-user')
                self.save_state()
                self.run_upgrade('preview')
                self.assertEqual(self.mutations(), [])

    def test_explicit_command_drift_still_fails_before_mutation(self):
        self.state['containers']['node']['Config']['Cmd'] = ['unexpected-command']
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Live command/user'):
            self.run_upgrade('preview')
        self.assertEqual(self.mutations(), [])

    def test_success_preserves_config_context_overrides_storage_and_checkpoint(self):
        original = self.env_file.read_bytes()
        before = {p: p.read_bytes() for p in self.private.iterdir() if p.is_file() and p != self.env_file}
        self.run_upgrade('apply', inbox_ready=RELEASE)
        state = self.read_state()
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        _, env, _ = upgrade.read_exports(self.env_file, {})
        self.assertEqual(env['OYA_NODE_IMAGE'], NEW)
        self.assertEqual(env['CUSTOM_OVERRIDE'], 'literal value = unchanged')
        self.assertEqual(env['COMPOSE_PROJECT_NAME'], 'fixture_project')
        self.assertIn(str(self.private / 'platform.yaml'), env['COMPOSE_FILE'])
        self.assertTrue(self.bundle.exists())
        self.assertTrue(state['containers']['node']['State']['Running'])
        self.assertEqual(state['containers']['ipfs'], self.state['containers']['ipfs'])
        self.assertEqual(state['checkpoint'], self.state['checkpoint'])
        self.assertTrue(all(e['context'] == 'fixture' for e in state['events']))
        self.assertTrue(all(e['custom'] == 'literal value = unchanged' for e in state['events']))
        up = [a for a in self.mutations() if a[:2] == ['compose', 'up']]
        self.assertEqual(len(up), 1)
        self.assertEqual(up[0][-1], 'node')
        self.assertIn('--no-deps', up[0])
        journals = list((self.private / '.oya-upgrades').glob('*/journal.json'))
        record = json.loads(journals[0].read_text())
        self.assertEqual(record['stage'], 'complete')
        self.assertNotIn('SENSITIVE', journals[0].read_text())
        backup = next(f for f in record['files'] if f['source'] == str(self.env_file))
        self.assertEqual((journals[0].parent / backup['backup']).read_bytes(), original)
        self.assertEqual(stat.S_IMODE(journals[0].stat().st_mode), 0o600)
        self.assertFalse((self.private / '.oya-upgrades/active.json').exists())

    def test_containerd_index_image_id_and_classic_config_id_are_supported(self):
        self.state['config_digest'] = NEW.split('@')[1]
        self.save_state()
        self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertEqual(self.read_state()['containers']['node']['Image'], NEW.split('@')[1])

    def test_unrelated_local_image_id_fails_before_stopping(self):
        self.state['config_digest'] = 'sha256:' + '9' * 64
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Pulled image identity'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertFalse(any(action[:2] == ['compose', 'stop'] for action in self.mutations()))

    def test_matching_index_for_wrong_local_platform_is_rejected(self):
        self.state['config_digest'] = NEW.split('@')[1]
        self.state['image_arch'] = 'arm64'
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Pulled image platform'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertFalse(any(action[:2] == ['compose', 'stop'] for action in self.mutations()))

    def test_custom_application_arguments_cannot_bypass_validated_settings(self):
        for role, service in [('inbox', 'inbox'), ('worker', 'node')]:
            with self.subTest(role=role):
                self.configure(role)
                alternate = self.private / 'alternate.json'
                self.put(alternate, '{"databaseUrl":"postgres://example.invalid/other","mode":"ledger"}')
                model = self.state['model']['services'][service]
                model['volumes'].append({'type': 'bind', 'source': str(alternate),
                                         'target': '/alternate.json', 'read_only': True})
                model['command'][1] = '/alternate.json'
                container = self.state['containers'][service]
                container['Config']['Cmd'] = model['command'][:]
                container['Mounts'].append({'Type': 'bind', 'Source': str(alternate),
                                             'Destination': '/alternate.json', 'RW': False})
                self.save_state()
                with self.assertRaisesRegex(upgrade.UpgradeError, 'Role command'):
                    self.run_upgrade('apply', workers_stopped=role == 'inbox',
                                     inbox_ready=RELEASE if role == 'worker' else None)
                self.assertEqual(self.mutations(), [])

    def test_recovery_trees_are_synced_before_committing_new_selectors(self):
        synced = set()
        real_sync, real_atomic, real_stop = os.fsync, upgrade.atomic, upgrade.stop_selected
        parent = self.private.stat()
        parent_identity = (parent.st_dev, parent.st_ino)
        def sync(fd):
            info = os.fstat(fd)
            synced.add((info.st_dev, info.st_ino))
            return real_sync(fd)
        def atomic(path, data):
            if path == self.env_file:
                self.assertIn(parent_identity, synced, 'Installation directory must be synced before selectors change')
                attempt = next((self.private / '.oya-upgrades').glob('*/journal.json')).parent
                for root in [attempt / 'configuration', attempt / 'release']:
                    for item in [root, *root.rglob('*')]:
                        info = item.stat()
                        self.assertIn((info.st_dev, info.st_ino), synced, str(item.relative_to(attempt)))
            return real_atomic(path, data)
        def stop(*args, **kwargs):
            self.assertIn(parent_identity, synced, 'Recovery root must be durable before service stop')
            return real_stop(*args, **kwargs)
        with patch.object(upgrade.os, 'fsync', side_effect=sync), patch.object(upgrade, 'atomic', side_effect=atomic), patch.object(upgrade, 'stop_selected', side_effect=stop):
            self.run_upgrade('apply', inbox_ready=RELEASE)

    def test_first_quiesce_syncs_recovery_root_parent_before_service_stop(self):
        parent = self.private.stat()
        synced = set()
        real_sync, real_stop = os.fsync, upgrade.stop_selected
        def sync(fd):
            info = os.fstat(fd)
            synced.add((info.st_dev, info.st_ino))
            return real_sync(fd)
        def stop(*args, **kwargs):
            self.assertIn((parent.st_dev, parent.st_ino), synced,
                          'Recovery root must be durable before quiesce')
            return real_stop(*args, **kwargs)
        with patch.object(upgrade.os, 'fsync', side_effect=sync), patch.object(upgrade, 'stop_selected', side_effect=stop):
            self.run_upgrade('quiesce')
        self.assertFalse(self.read_state()['containers']['node']['State']['Running'])

    def test_recovery_root_parent_sync_failure_prevents_any_mutation(self):
        parent = self.private.stat()
        original = self.env_file.read_bytes()
        real_sync = os.fsync
        def sync(fd):
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) == (parent.st_dev, parent.st_ino):
                raise OSError('PRIVATE_PARENT_SYNC_FAILURE')
            return real_sync(fd)
        with patch.object(upgrade.os, 'fsync', side_effect=sync):
            with self.assertRaises(OSError):
                self.run_upgrade('quiesce')
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.env_file.read_bytes(), original)
        self.assertTrue(self.read_state()['containers']['node']['State']['Running'])

    def test_recovery_sync_failure_keeps_services_running_and_records_phase(self):
        with patch.object(upgrade, 'sync_tree', side_effect=OSError('PRIVATE_FILESYSTEM_DETAILS')):
            with self.assertRaises(OSError):
                self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertEqual(self.mutations(), [])
        record = json.loads(next((self.private / '.oya-upgrades').glob('*/journal.json')).read_text())
        self.assertEqual(record['failed_stage'], 'backing-up-configuration')
        self.assertEqual(record['error_category'], 'filesystem')
        self.assertNotIn('PRIVATE_FILESYSTEM_DETAILS', json.dumps(record))
        self.assertTrue(self.read_state()['containers']['node']['State']['Running'])

    def test_reporting_failure_after_success_does_not_stop_verified_service(self):
        def report(message, *args, **kwargs):
            if str(message).startswith('Upgrade complete:'):
                raise BrokenPipeError('closed output')
        with patch('builtins.print', side_effect=report):
            with self.assertRaises(BrokenPipeError):
                self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertTrue(self.read_state()['containers']['node']['State']['Running'])
        record = json.loads(next((self.private / '.oya-upgrades').glob('*/journal.json')).read_text())
        self.assertEqual(record['stage'], 'complete')
        self.assertFalse((self.private / '.oya-upgrades/active.json').exists())

    def test_inbox_gate_stops_before_backup_and_starts_only_inbox(self):
        self.configure('inbox')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'ALL workers'):
            self.run_upgrade('apply')
        self.assertEqual(self.mutations(), [])
        self.run_upgrade('apply', workers_stopped=True)
        actions = self.mutations()
        stop = next(i for i, a in enumerate(actions) if a[:2] == ['compose', 'stop'])
        dump = next(i for i, a in enumerate(actions) if 'pg_dump' in a)
        verify = next(i for i, a in enumerate(actions) if 'pg_restore' in a)
        up = next(i for i, a in enumerate(actions) if a[:2] == ['compose', 'up'])
        self.assertLess(stop, dump)
        self.assertLess(dump, verify)
        self.assertLess(verify, up)
        self.assertEqual(actions[up][-1], 'inbox')
        self.assertEqual(self.read_state()['containers']['postgres'], self.state['containers']['postgres'])
        self.assertEqual(self.read_state()['checkpoint'], self.state['checkpoint'])

    def add_proxy(self):
        self.state['model']['services']['proxy'] = {
            'image': 'fixture-proxy@sha256:' + '7' * 64, 'restart': 'unless-stopped',
            'ports': [{'target': 80, 'published': '80', 'protocol': 'tcp'},
                      {'target': 443, 'published': '443', 'protocol': 'tcp'}],
            'volumes': [{'type': 'bind', 'source': str(self.bundle / 'node/production/inbox/Caddyfile'),
                         'target': '/etc/caddy/Caddyfile', 'read_only': True}]}
        self.state['containers']['proxy'] = {
            'Id': 'original-proxy', 'Config': {'Image': 'fixture-proxy@sha256:' + '7' * 64,
                'Labels': {'com.docker.compose.service': 'proxy', 'com.docker.compose.oneoff': 'False'}},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}, 'PortBindings': {
                str(port) + '/tcp': [{'HostIp': '0.0.0.0', 'HostPort': str(port)},
                                    {'HostIp': '::', 'HostPort': str(port)}] for port in [80, 443]}},
            'Mounts': [{'Type': 'bind', 'Source': str(self.bundle / 'node/production/inbox/Caddyfile'),
                        'Destination': '/etc/caddy/Caddyfile', 'RW': False}],
            'State': {'Running': True}}
        self.save_state()

    def test_inbox_keeps_proxy_old_public_mount_and_supports_next_preview(self):
        self.configure('inbox')
        self.add_proxy()
        proxy = copy.deepcopy(self.state['containers']['proxy'])
        self.run_upgrade('apply', workers_stopped=True)
        self.assertEqual(self.read_state()['containers']['proxy'], proxy)
        self.run_upgrade('preview')
        self.assertEqual(self.read_state()['containers']['proxy'], proxy)

    def test_changed_new_caddyfile_is_rejected_before_pull_or_stop(self):
        self.configure('inbox')
        self.add_proxy()
        def changed(tag, destination):
            result = self.release(tag, destination)
            self.put(Path(result['bundle']) / 'node/production/inbox/Caddyfile', '# changed proxy policy')
            return result
        with patch.object(upgrade, 'release_assets', side_effect=changed):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'Dependency public bind asset changed'):
                self.run_upgrade('apply', workers_stopped=True)
        self.assertEqual(self.mutations(), [])

    def test_path_extension_uses_inherited_path_and_preserves_saved_line(self):
        line = 'export PATH=' + shlex.quote(str(self.bin)) + ':"$PATH"\n'
        self.put(self.env_file, self.env_file.read_text() + line)
        self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertTrue(self.env_file.read_text().endswith(line))

    def test_worker_requires_same_release_counterpart_ack(self):
        for ready in [None, 'node-v0.3.1']:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'SAME release'):
                self.run_upgrade('apply', inbox_ready=ready)
        self.assertEqual(self.mutations(), [])

    def test_quiesce_stops_only_worker_and_keeps_saved_selection(self):
        before = self.env_file.read_bytes()
        self.run_upgrade('quiesce')
        self.assertEqual(self.mutations(), [['compose', 'stop', 'node']])
        self.assertFalse(self.read_state()['containers']['node']['State']['Running'])
        self.assertTrue(self.read_state()['containers']['ipfs']['State']['Running'])
        self.assertEqual(self.env_file.read_bytes(), before)
        record_path = next((self.private / '.oya-upgrades').glob('*/journal.json'))
        self.assertIn(str(record_path.parent), self.output.getvalue())
        record = json.loads(record_path.read_text())
        self.assertEqual(record['compose_project'], 'fixture_project')
        self.assertIn(str(self.env_file), record['configuration_fingerprints'])

    def test_live_storage_drift_and_orphans_are_rejected(self):
        self.state['containers']['node']['Mounts'][0]['Source'] += '-other'
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Live mounts'):
            self.run_upgrade()
        self.assertEqual(self.mutations(), [])
        self.configure('worker')
        self.state['containers']['orphan'] = copy.deepcopy(self.state['containers']['node'])
        self.state['containers']['orphan']['Config']['Labels']['com.docker.compose.service'] = 'orphan'
        self.state['containers']['orphan']['Id'] = 'orphan-id'
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'orphan'):
            self.run_upgrade()

    def test_new_compose_change_fails_before_pull_or_stop(self):
        self.state['drift'] = True
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'New Compose model'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertEqual(self.mutations(), [])

    def test_uncertain_up_failure_stops_worker_retains_new_selection_and_blocks_retry(self):
        self.state['fail_after'] = ['compose', 'up']
        self.save_state()
        with self.assertRaises(upgrade.UpgradeError):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        state = self.read_state()
        self.assertFalse(state['containers']['node']['State']['Running'])
        self.assertEqual(state['checkpoint'], self.state['checkpoint'])
        self.assertIn(NEW.encode(), self.env_file.read_bytes())
        record = json.loads(next((self.private / '.oya-upgrades').glob('*/journal.json')).read_text())
        self.assertEqual(record['failed_stage'], 'starting')
        self.assertEqual(record['error_category'], 'command-or-validation')
        self.assertTrue(record['shutdown_confirmed'])
        self.assertTrue((self.private / '.oya-upgrades/active.json').exists())
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Unresolved'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertNotIn('SENSITIVE', self.output.getvalue())

    def test_unhealthy_start_stops_worker(self):
        self.state['unhealthy'] = True
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'healthy'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertFalse(self.read_state()['containers']['node']['State']['Running'])

    def test_forced_shutdown_blocks_restart_and_preserves_checkpoint(self):
        self.state['containers']['node']['State']['ExitCode'] = 137
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'forced or failed'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertFalse(any(a[:2] == ['compose', 'up'] for a in self.mutations()))
        self.assertEqual(self.read_state()['checkpoint'], self.state['checkpoint'])

    def test_live_network_and_port_drift_are_rejected(self):
        self.state['containers']['node']['NetworkSettings'] = {'Networks': {'unexpected-network': {}}}
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'network topology'):
            self.run_upgrade()
        self.configure('worker')
        self.state['containers']['node']['HostConfig']['PortBindings'] = {'8787/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8787'}]}
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'port bindings'):
            self.run_upgrade()

    def test_external_database_and_custom_database_are_rejected(self):
        self.configure('inbox')
        self.put(self.private / 'inbox-secrets.json', json.dumps({'databaseUrl': 'postgresql://oya:FIXTURE_PASSWORD@external.invalid/oya'}))
        with self.assertRaisesRegex(upgrade.UpgradeError, 'external database'):
            self.run_upgrade()
        self.configure('inbox')
        self.state['model']['services']['postgres']['environment']['POSTGRES_DB'] = 'other'
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'database/user'):
            self.run_upgrade()

    def test_desktop_mount_prefix_and_order_are_normalized_only_on_desktop(self):
        self.state['os'] = 'Docker Desktop'
        self.state['containers']['node']['Mounts'].reverse()
        for mount in self.state['containers']['node']['Mounts']:
            mount['Source'] = '/host_mnt' + mount['Source']
        self.save_state()
        self.run_upgrade()
        self.state = self.read_state()
        self.state['os'] = 'Linux'
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Keychain-managed|Live mounts'):
            self.run_upgrade()

    def test_stop_failure_is_reported_as_unconfirmed_without_start(self):
        self.state['fail_before'] = ['compose', 'stop']
        self.save_state()
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaises(upgrade.UpgradeError):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertIn('shutdown unconfirmed', errors.getvalue())
        self.assertTrue(self.read_state()['containers']['node']['State']['Running'])
        self.assertFalse(any(a[:2] == ['compose', 'up'] for a in self.mutations()))
        self.assertNotIn('SENSITIVE', errors.getvalue())
        marker = json.loads((self.private / '.oya-upgrades/active.json').read_text())
        journal = json.loads((self.private / '.oya-upgrades' / marker['attempt'] / 'journal.json').read_text())
        self.assertFalse(journal['shutdown_confirmed'])

    def test_changed_configuration_between_pull_and_stop_fails_closed(self):
        command = upgrade.command
        def change_after_pull(args, env, **kwargs):
            result = command(args, env, **kwargs)
            if args[:2] == ['docker', 'pull']:
                self.put(self.private / 'node.json', '{"mode":"ledger"}')
            return result
        with patch.object(upgrade, 'command', side_effect=change_after_pull):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'Configuration changed'):
                self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertFalse(any(a[:2] == ['compose', 'up'] for a in self.mutations()))
        self.assertTrue(self.read_state()['containers']['node']['State']['Running'])

    def test_backup_verification_failure_never_restarts_inbox(self):
        self.configure('inbox')
        self.state['fail_before'] = ['compose', 'exec', '-T', 'postgres', 'pg_restore']
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'pg_restore'):
            self.run_upgrade('apply', workers_stopped=True)
        self.assertFalse(self.read_state()['containers']['inbox']['State']['Running'])
        self.assertFalse(any(a[:2] == ['compose', 'up'] for a in self.mutations()))

    def test_ledger_implicit_defaults_rejected_and_explicit_identity_preserved(self):
        self.put(self.private / 'node.json', json.dumps({'mode': 'ledger'}))
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Ledger chain'):
            self.run_upgrade()
        self.put(self.private / 'node.json', json.dumps({'mode': 'ledger', 'chainId': 11155111,
                 'ledgerContract': '0x' + '1' * 40, 'rpcUrl': 'https://rpc.example.invalid'}))
        original = (self.private / 'node.json').read_bytes()
        self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertEqual(original, (self.private / 'node.json').read_bytes())

    def test_backup_failure_keeps_inbox_stopped_and_old_environment(self):
        self.configure('inbox')
        original = self.env_file.read_bytes()
        self.state['fail_before'] = ['compose', 'exec', '-T', 'postgres', 'pg_dump']
        self.save_state()
        with self.assertRaises(upgrade.UpgradeError):
            self.run_upgrade('apply', workers_stopped=True)
        self.assertEqual(self.env_file.read_bytes(), original)
        self.assertFalse(self.read_state()['containers']['inbox']['State']['Running'])
        self.assertTrue(self.read_state()['containers']['postgres']['State']['Running'])
        self.assertFalse(any(a[:2] == ['compose', 'up'] for a in self.mutations()))

    def test_pull_failure_does_not_stop_running_worker(self):
        original = self.env_file.read_bytes()
        self.state['fail_before'] = ['pull']
        self.save_state()
        with self.assertRaises(upgrade.UpgradeError):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertTrue(self.read_state()['containers']['node']['State']['Running'])
        self.assertEqual(self.env_file.read_bytes(), original)
        self.assertEqual(len(self.mutations()), 1)

    def test_image_validation_failure_precedes_mutation(self):
        self.state['config_digest'] = 'sha256:' + '9' * 64
        self.save_state()
        with self.assertRaisesRegex(upgrade.UpgradeError, 'image identity'):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertFalse(any(a[:2] == ['compose', 'stop'] for a in self.mutations()))

    def test_missing_explicit_mode_fails_closed(self):
        self.put(self.private / 'node.json', '{}')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'mode explicitly'):
            self.run_upgrade()

    @contextlib.contextmanager
    def macos_keychain_user(self, uid=501):
        selection = upgrade.keychain_selection
        def select(*args):
            # Mock only the platform gate; filesystem ownership uses the real UID.
            with patch.object(upgrade.os, 'getuid', return_value=uid):
                return selection(*args)
        with patch.object(upgrade.sys, 'platform', 'darwin'), \
                patch.object(upgrade, 'keychain_selection', side_effect=select):
            yield

    def test_keychain_root_user_is_rejected_before_mutation(self):
        self.configure('worker', keychain=True)
        with self.macos_keychain_user(uid=0), self.assertRaisesRegex(upgrade.UpgradeError, 'non-root'):
            self.run_upgrade(keychain_account='fixture', keychain_service='fixture.worker')
        self.assertEqual(self.mutations(), [])

    def test_private_files_reject_another_owner(self):
        with patch.object(upgrade.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'owned, private'):
                upgrade.private(self.env_file)

    def test_keychain_detected_without_arguments_and_preview_never_reads_keychain(self):
        self.configure('worker', keychain=True)
        with self.assertRaisesRegex(upgrade.UpgradeError, 'Keychain-managed'):
            self.run_upgrade()
        with self.macos_keychain_user():
            self.run_upgrade(keychain_account='fixture', keychain_service='fixture.worker')
        self.assertEqual(self.mutations(), [])
        self.assertFalse((self.private / '.keychain-runtime/worker.json').exists())

    def test_keychain_apply_uses_existing_helper_no_dependencies_and_unlinks_secret(self):
        self.configure('worker', keychain=True)
        original_command = upgrade.command
        security_calls = []
        def execute(args, env, **kwargs):
            if args[0] == '/usr/bin/security':
                security_calls.append(args)
                return (('x' * 43) + '\n').encode()
            return original_command(args, env, **kwargs)
        with self.macos_keychain_user(), patch.object(upgrade, 'command', side_effect=execute):
            self.run_upgrade('apply', inbox_ready=RELEASE, keychain_account='fixture', keychain_service='fixture.worker')
        self.assertEqual(len(security_calls), 1)
        self.assertNotIn('x' * 43, str(security_calls) + self.output.getvalue())
        self.assertFalse((self.private / '.keychain-runtime/worker.json').exists())
        self.assertEqual(self.read_state()['containers']['node']['HostConfig']['RestartPolicy']['Name'], 'no')
        self.assertTrue(self.read_state()['containers']['ipfs']['State']['Running'])
        self.assertNotIn('compose.keychain-worker.yaml', self.env_file.read_text())

    def test_keychain_uncertain_start_failure_stops_and_removes_plaintext(self):
        self.configure('worker', keychain=True)
        self.state['fail_after'] = ['compose', 'up']
        self.save_state()
        original_command = upgrade.command
        def execute(args, env, **kwargs):
            if args[0] == '/usr/bin/security':
                return (('x' * 43) + '\n').encode()
            return original_command(args, env, **kwargs)
        with self.macos_keychain_user(), patch.object(upgrade, 'command', side_effect=execute):
            with self.assertRaises(upgrade.UpgradeError):
                self.run_upgrade('apply', inbox_ready=RELEASE, keychain_account='fixture', keychain_service='fixture.worker')
        self.assertNotIn('node', self.read_state()['containers'])
        self.assertFalse((self.private / '.keychain-runtime/worker.json').exists())
        self.assertTrue((self.private / '.oya-upgrades/active.json').exists())
        self.assertEqual(self.read_state()['checkpoint'], self.state['checkpoint'])

    def test_atomic_environment_save_failure_stops_without_start_or_partial_file(self):
        original = self.env_file.read_bytes()
        atomic = upgrade.atomic
        def save(path, data):
            if path == self.env_file:
                raise OSError('fixture disk failure')
            atomic(path, data)
        with patch.object(upgrade, 'atomic', side_effect=save), self.assertRaises(OSError):
            self.run_upgrade('apply', inbox_ready=RELEASE)
        self.assertEqual(self.env_file.read_bytes(), original)
        self.assertFalse(self.read_state()['containers']['node']['State']['Running'])
        self.assertFalse(any(a[:2] == ['compose', 'up'] for a in self.mutations()))

    def test_lock_serializes_operations(self):
        journal = upgrade.Journal(self.private, 'worker', RELEASE)
        try:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'Another upgrade'):
                upgrade.Journal(self.private, 'worker', RELEASE)
        finally:
            journal.close()

    def test_cli_failure_is_nonzero_and_sanitized(self):
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            result = upgrade.main(['preview', '--role', 'worker', '--env-file', str(self.private / 'missing.env'), '--release', RELEASE])
        self.assertEqual(result, 1)
        self.assertNotIn(str(self.private), errors.getvalue())


def shutil_copy(source, target):
    import shutil
    shutil.copytree(source, target)


class PureTests(unittest.TestCase):
    def test_only_path_supports_tightly_scoped_inherited_expansion(self):
        self.assertEqual(upgrade.literal_export('/Applications/Docker.app/Contents/Resources/bin:"$PATH"', '/usr/bin'),
                         '/Applications/Docker.app/Contents/Resources/bin:/usr/bin')
        for value in ['/prefix:"$PATH"', '/prefix:${PATH}']:
            self.assertEqual(upgrade.literal_export(value, '/usr/bin:/bin'), '/prefix:/usr/bin:/bin')
        for value in ['$OTHER', '${PATH:-fallback}', '$PATH_SUFFIX', '$(unsafe)', '`unsafe`', '$PATH;unsafe']:
            with self.subTest(value=value), self.assertRaises(upgrade.UpgradeError):
                upgrade.literal_export(value, '/usr/bin')
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.literal_export('"$PATH"')

    def test_wildcard_ports_accept_dual_stack_but_reject_changed_ports_and_exposure(self):
        service = {'ports': [{'target': 4001, 'published': '4001', 'protocol': protocol} for protocol in ['tcp', 'udp']]}
        container = {'HostConfig': {'PortBindings': {str(4001) + '/' + protocol:
                     [{'HostIp': '0.0.0.0', 'HostPort': '4001'}, {'HostIp': '::', 'HostPort': '4001'}] for protocol in ['tcp', 'udp']}}}
        upgrade.validate_ports(service, container)
        wrong = copy.deepcopy(container)
        wrong['HostConfig']['PortBindings']['4001/tcp'][0]['HostPort'] = '4002'
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.validate_ports(service, wrong)
        restricted = copy.deepcopy(service)
        restricted['ports'][0]['host_ip'] = '127.0.0.1'
        with self.assertRaises(upgrade.UpgradeError):
            upgrade.validate_ports(restricted, container)

    def test_release_version_is_explicit_and_strict(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for release in ['latest', 'v0.4.0', 'node-v00.4.0', 'node-v0.4.0\n']:
                with self.assertRaises(SystemExit):
                    upgrade.parse_args(['preview', '--role', 'worker', '--env-file', 'compose.env', '--release', release])

    def test_subprocess_failure_and_timeout_do_not_leak_output(self):
        for result in [subprocess.CompletedProcess([], 7, b'SECRET', b'SECRET'), subprocess.TimeoutExpired([], 1, b'SECRET')]:
            with patch.object(upgrade.subprocess, 'run', side_effect=result if isinstance(result, Exception) else None,
                              return_value=result):
                with self.assertRaises(upgrade.UpgradeError) as error:
                    upgrade.command(['fixture'], {})
                self.assertNotIn('SECRET', str(error.exception))

    def test_literal_environment_rejects_code_and_preserves_unrelated_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'compose.env'
            for value in ['$(touch /unsafe)', '`unsafe`', '$HOME/x', '${HOME}/x', 'a b']:
                path.write_text('export TEST=' + value + '\n');path.chmod(0o600)
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.read_exports(path, {})
            original = b'# keep\nexport TARGET=old\nexport OTHER=a\\ b\n'
            path.write_bytes(original)
            raw, env, assignments = upgrade.read_exports(path, {})
            self.assertEqual(env['OTHER'], 'a b')
            self.assertEqual(upgrade.replace_exports(raw, assignments, {'TARGET': 'new space'}),
                             b"# keep\nexport TARGET='new space'\nexport OTHER=a\\ b\n")
            for literal in ['literal#fragment', 'literal $dollar', 'escaped `tick`', 'space and \'quote\'']:
                path.write_text('export TEST=' + shlex.quote(literal) + '\n')
                self.assertEqual(upgrade.read_exports(path, {})[1]['TEST'], literal)

    def test_tar_rejects_traversal_links_devices_unknown_assets_duplicate_and_bombs(self):
        members = []
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('node/production/evil', tarfile.SYMTYPE), ('node/production/evil', tarfile.LNKTYPE),
                           ('node/production/evil', tarfile.CHRTYPE), ('node/production/evil.py', tarfile.REGTYPE)]:
            member = tarfile.TarInfo(name);member.type = kind;members.append(member)
        duplicate = tarfile.TarInfo('node/production/image.txt');members.append(duplicate)
        for member in members:
            with self.subTest(member=member.name, kind=member.type), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.safe_extract(archive(extra=member), Path(directory))
        with patch.object(upgrade, 'MAX_EXPANDED', 512), tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'Expanded archive'):
                upgrade.safe_extract(gzip.compress(b'0' * 2048), Path(directory))

    def test_tar_retains_readable_public_modes_under_private_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = os.umask(0o077)
            try:
                upgrade.safe_extract(archive(), Path(directory))
            finally:
                os.umask(previous)
            self.assertEqual(stat.S_IMODE((Path(directory) / 'node/production/image.txt').stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE((Path(directory) / 'node/production').stat().st_mode), 0o755)

    def release_fixture(self, reference=None, tag_objects=None):
        data = {'image.txt': (NEW + '\n').encode(),
                'release.txt': f'Git tag: {RELEASE}\nGit commit: {COMMIT}\nImage: {NEW}\n'.encode(),
                'oya-node-v0.4.0.tar.gz': archive()}
        metadata = {'tag_name': RELEASE, 'draft': False, 'prerelease': False,
                    'body': data['release.txt'].decode().strip() + '\nArchive SHA-256: ' + upgrade.sha(data['oya-node-v0.4.0.tar.gz']),
                    'assets': [{'name': name, 'browser_download_url': upgrade.SOURCE + '/releases/download/' + RELEASE + '/' + name,
                                'digest': 'sha256:' + upgrade.sha(value), 'size': len(value)} for name, value in data.items()]}
        if reference is None:
            reference = {'ref': 'refs/tags/' + RELEASE, 'object': {'type': 'commit', 'sha': COMMIT}}
        def fetch(url, limit, headers=None):
            api = 'https://api.github.com/repos/' + upgrade.REPOSITORY
            if url == api + '/git/ref/tags/' + RELEASE:
                return json.dumps(reference).encode()
            if url.startswith(api + '/git/tags/'):
                return json.dumps((tag_objects or {})[url.rsplit('/', 1)[1]]).encode()
            return json.dumps(metadata).encode() if '/releases/tags/' in url else data[url.rsplit('/', 1)[1]]
        return data, metadata, fetch

    def test_release_tag_commit_must_match_manifest_before_extraction(self):
        for annotated in [False, True]:
            tag_sha = 'a' * 40
            target = {'type': 'commit', 'sha': '9' * 40}
            reference = {'ref': 'refs/tags/' + RELEASE,
                         'object': {'type': 'tag', 'sha': tag_sha} if annotated else target}
            _, _, fetch = self.release_fixture(reference, {tag_sha: {'sha': tag_sha, 'object': target}})
            with self.subTest(annotated=annotated), patch.object(upgrade, 'fetch', side_effect=fetch), \
                    patch.object(upgrade, 'safe_extract', wraps=upgrade.safe_extract) as extract, tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(upgrade.UpgradeError, 'tag.*commit'):
                    upgrade.release_assets(RELEASE, Path(directory))
                extract.assert_not_called()
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_release_peels_annotated_and_nested_tags(self):
        for depth in [1, 2]:
            hashes = ['a' * 40, 'b' * 40]
            objects = {hashes[i]: {'sha': hashes[i], 'object':
                       {'type': 'tag', 'sha': hashes[i + 1]} if i + 1 < depth else
                       {'type': 'commit', 'sha': COMMIT}} for i in range(depth)}
            reference = {'ref': 'refs/tags/' + RELEASE, 'object': {'type': 'tag', 'sha': hashes[0]}}
            _, _, fetch = self.release_fixture(reference, objects)
            with self.subTest(depth=depth), patch.object(upgrade, 'fetch', side_effect=fetch) as request, \
                    tempfile.TemporaryDirectory() as directory:
                self.assertEqual(upgrade.release_assets(RELEASE, Path(directory))['commit'], COMMIT)
                self.assertEqual(sum('/git/tags/' in call.args[0] for call in request.call_args_list), depth)

    def test_release_rejects_unverifiable_tag_references(self):
        tag_sha = 'a' * 40
        valid = {'ref': 'refs/tags/' + RELEASE, 'object': {'type': 'commit', 'sha': COMMIT}}
        cases = [None, [], {}, dict(valid, ref='refs/tags/other'),
                 dict(valid, object=None), dict(valid, object={'type': 'tree', 'sha': COMMIT}),
                 dict(valid, object={'type': 'commit', 'sha': 'not-a-sha'}),
                 dict(valid, object={'type': 'tag', 'sha': tag_sha})]
        for reference in cases:
            # The annotated case cycles; it must not loop or accept a tag as a commit.
            _, _, fetch = self.release_fixture()
            def response(url, limit, headers=None):
                if '/git/ref/' in url:
                    return json.dumps(reference).encode()
                if '/git/tags/' in url:
                    return json.dumps({'sha': tag_sha, 'object': {'type': 'tag', 'sha': tag_sha}}).encode()
                return fetch(url, limit, headers)
            with self.subTest(reference=reference), patch.object(upgrade, 'fetch', side_effect=response), \
                    tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.release_assets(RELEASE, Path(directory))

    def test_tag_lookup_errors_and_excessive_depth_fail_closed(self):
        for response in [b'not-json', b'[]', upgrade.UpgradeError('Release retrieval failed.')]:
            with self.subTest(response=response), patch.object(upgrade, 'fetch',
                    side_effect=response if isinstance(response, Exception) else None, return_value=response):
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.release_tag_commit(RELEASE)
        hashes = [f'{index:040x}' for index in range(18)]
        reference = {'ref': 'refs/tags/' + RELEASE, 'object': {'type': 'tag', 'sha': hashes[0]}}
        for fault in ['identity', 'depth', 'missing-target']:
            objects = {hashes[i]: {'sha': hashes[i], 'object': {'type': 'tag', 'sha': hashes[i + 1]}}
                       for i in range(17)}
            if fault == 'identity':
                objects[hashes[0]]['sha'] = hashes[1]
            elif fault == 'missing-target':
                objects[hashes[0]].pop('object')
            _, _, fetch = self.release_fixture(reference, objects)
            with self.subTest(fault=fault), patch.object(upgrade, 'fetch', side_effect=fetch) as request:
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.release_tag_commit(RELEASE)
                self.assertLessEqual(request.call_count, 17)

    def test_release_asset_checksums_manifest_and_embedded_image_match(self):
        data, metadata, fetch = self.release_fixture()
        with patch.object(upgrade, 'fetch', side_effect=fetch), tempfile.TemporaryDirectory() as directory:
            result = upgrade.release_assets(RELEASE, Path(directory))
            self.assertEqual(result['image'], NEW)
            self.assertEqual(result['commit'], COMMIT)
        for change in ['checksum', 'manifest', 'embedded', 'notes', 'tag']:
            data, metadata, fetch = self.release_fixture()
            if change == 'checksum':
                data['image.txt'] = b'altered'
            elif change == 'manifest':
                data['release.txt'] = data['release.txt'].replace(RELEASE.encode(), b'node-v0.3.1')
            elif change == 'embedded':
                data['oya-node-v0.4.0.tar.gz'] = archive({'node/production/image.txt': OLD.encode()})
            elif change == 'notes':
                metadata['body'] = 'No published checksum'
            else:
                metadata['tag_name'] = 'node-v0.3.1'
            if change in ['manifest', 'embedded']:
                for asset in metadata['assets']:
                    asset['digest'] = 'sha256:' + upgrade.sha(data[asset['name']]);asset['size'] = len(data[asset['name']])
                metadata['body'] = data['release.txt'].decode().strip() + '\n' + upgrade.sha(data['oya-node-v0.4.0.tar.gz'])
            with self.subTest(change=change), patch.object(upgrade, 'fetch', side_effect=fetch), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(upgrade.UpgradeError):
                    upgrade.release_assets(RELEASE, Path(directory))

    def test_registry_checks_root_manifest_config_digest_platform_and_labels(self):
        release = {'tag': RELEASE, 'image': NEW, 'commit': COMMIT}
        config = json.dumps({'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': LABELS}}).encode()
        config_digest = 'sha256:' + upgrade.sha(config)
        manifest = json.dumps({'config': {'digest': config_digest}}).encode()
        digest = 'sha256:' + upgrade.sha(manifest)
        release['image'] = upgrade.IMAGE_REPOSITORY + '@' + digest
        def fetch(url, limit, headers=None):
            if '/token?' in url:return b'{"token":"PUBLIC_REGISTRY_TOKEN"}'
            return config if '/blobs/' in url else manifest
        with patch.object(upgrade, 'fetch', side_effect=fetch):
            self.assertEqual(upgrade.registry_identity(release, 'linux/amd64'), config_digest)
            with self.assertRaisesRegex(upgrade.UpgradeError, 'platform'):
                upgrade.registry_identity(release, 'linux/arm64')
            wrong = dict(release, commit='9' * 40)
            with self.assertRaisesRegex(upgrade.UpgradeError, 'labels'):
                upgrade.registry_identity(wrong, 'linux/amd64')
            wrong = dict(release, image=NEW)
            with self.assertRaisesRegex(upgrade.UpgradeError, 'digest mismatch'):
                upgrade.registry_identity(wrong, 'linux/amd64')


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main(verbosity=2)
