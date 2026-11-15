import json
import os
import importlib.util
from unittest import mock
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('render.py')

class RenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.secret = self.root / 'secret'
        self.secret.write_text('SYNTHETIC_PRIVATE_VALUE')
        self.config = dict(primary_major=16, standby_major=16, postgres_image='postgres@sha256:' + 'a'*64,
            app_image='ghcr.io/itkadr-git/myrmidon@sha256:' + 'b'*64, cpu=2, memory_mb=4096,
            required_cpu=1, required_memory_mb=2048, free_disk_mb=20000, required_disk_mb=10000,
            wal_keep_mb=1024, max_slot_wal_keep_mb=4096, slot='geo_slot', primary_host='primary.example',
            primary_port=5432, replication_user='replicator', tls_server_name='primary.example',
            ca_file=str(self.secret), passfile=str(self.secret), cert_file=str(self.secret), key_file=str(self.secret))

    def run_config(self, config):
        path = self.root / 'input.json'
        path.write_text(json.dumps(config))
        return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)

    def test_valid_stable_and_secret_free(self):
        a = self.run_config(self.config)
        b = self.run_config(self.config)
        self.assertEqual(a.returncode, 0, a.stderr)
        self.assertEqual(a.stdout, b.stdout)
        self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', a.stdout + a.stderr)
        out = json.loads(a.stdout)
        self.assertNotIn('ports', out['services']['standby'])
        self.assertEqual(out['services']['cold-app']['profiles'], ['manual-cold-app'])
        self.assertNotIn('ports', out['services']['cold-app'])

    def test_unreadable_secret_is_rejected(self):
        spec = importlib.util.spec_from_file_location('render', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with mock.patch('pathlib.Path.open', side_effect=PermissionError):
            with self.assertRaises(ValueError):
                module.render(self.config)

    def test_startup_guard_and_cold_app_isolation(self):
        output = json.loads(self.run_config(self.config).stdout)
        standby = output['services']['standby']
        script = standby['command'][0]
        self.assertIn('docker-entrypoint.sh', script)
        cold = output['services']['cold-app']
        self.assertEqual(cold['network_mode'], 'none')
        self.assertNotIn('volumes', cold)
        self.assertEqual(cold['environment']['HEARTBEAT_SCHEDULER_ENABLED'], 'false')
        self.assertEqual(cold['environment']['MYRMIDON_DB_BACKUP_ENABLED'], 'false')
        self.assertEqual(cold['environment']['MYRMIDON_PROCESS_ROLE'], 'api')

    def test_startup_guard_executes_only_for_prepared_compatible_data(self):
        output = json.loads(self.run_config(self.config).stdout)
        command = output['services']['standby']['command']
        data = self.root / 'data'
        data.mkdir()
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        marker = self.root / 'started'
        for name, body in [('postgres', 'printf "postgres (PostgreSQL) 16.4\\n"'),
                           ('docker-entrypoint.sh', f'printf "%s\\n" "$@" > "{marker}"')]:
            path = bin_dir / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        script = command[0].replace('/var/lib/postgresql/data', str(data))
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'])
        def start():
            return subprocess.run(['/bin/sh', '-ec', script, *command[1:]], env=env, capture_output=True)
        self.assertNotEqual(start().returncode, 0)
        (data / 'standby.signal').touch()
        (data / 'PG_VERSION').write_text('15\n')
        self.assertNotEqual(start().returncode, 0)
        self.assertFalse(marker.exists())
        (data / 'PG_VERSION').write_text('16\n')
        self.assertEqual(start().returncode, 0)
        self.assertEqual(marker.read_text().splitlines()[0], 'postgres')
        (bin_dir / 'postgres').write_text('#!/bin/sh\nprintf "postgres (PostgreSQL) 15.4\\n"\n')
        marker.unlink()
        self.assertNotEqual(start().returncode, 0)
        self.assertFalse(marker.exists())

    def test_missing_parameters_fail(self):
        for key in self.config:
            with self.subTest(key=key):
                config = dict(self.config)
                del config[key]
                self.assertNotEqual(self.run_config(config).returncode, 0)

    def test_invalid_inputs_fail(self):
        for key, value in [('app_image', 'ghcr.io/itkadr-git/myrmidon:latest'), ('postgres_image', 'postgres:16'),
                           ('primary_major', 15), ('cpu', 0), ('memory_mb', 1), ('free_disk_mb', 1),
                           ('wal_keep_mb', 0), ('max_slot_wal_keep_mb', -1), ('slot', 'BAD SLOT'),
                           ('ca_file', '/nonexistent'), ('primary_host', 'bad host'), ('primary_port', 0)]:
            with self.subTest(key=key):
                config = dict(self.config, **{key: value})
                result = self.run_config(config)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', result.stdout + result.stderr)

if __name__ == '__main__':
    unittest.main()
