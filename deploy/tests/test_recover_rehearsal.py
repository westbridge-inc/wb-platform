"""[FABLE-05 3.1] The rehearsal: from a signed backup to a SERVING database, on
real Postgres containers (the stack's own image), with nothing published: every
container is on a private Docker network or none, so nothing listens beyond
this machine. Removed at the end, whatever happens.

  1. "the old host": a Compose project from the stack's own docker-compose.yml
     (postgres only), with the shape that matters here: the migrations' group
     roles, grants, a forced row-security policy, PostGIS, a deployment
     identity, and a runtime login that a pg_dump does not carry;
  2. a backup as backup.sh makes it (pg_dump -Fc) signed as backup.sh signs it;
  3. the old host is destroyed (its volume too);
  4. "the new host": a fresh project, a fresh cluster with no role;
  5. restore.sh in its disaster mode keeps a quarantined copy (exit 3);
  6. recover.sh promotes it: the group roles made as the migrations make them,
     every row back, a login re-created afterwards reads through its policy;
  7. damage, then recover.sh again over the LIVE database: refused without the
     flag, refused without a terminal, refused on a wrong confirmation; with
     the flag and the typed confirmation it backs the damaged database up,
     keeps it renamed and closed, and every row is back.

Runs where Docker and the postgis image are present; CI pulls the image and
sets SWIFT_REQUIRE_REHEARSAL=1, so there it never skips."""
import os
import pty
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1]
IMAGE = 'postgis/postgis:16-3.4'
REQUIRED = os.environ.get('SWIFT_REQUIRE_REHEARSAL') == '1'


def docker_ready():
    if not shutil.which('docker') or not shutil.which('pg_restore'):
        return 'docker or pg_restore is not installed'
    if subprocess.run(['docker', 'info'], capture_output=True).returncode != 0:
        return 'the Docker daemon is not reachable'
    if subprocess.run(['docker', 'image', 'inspect', IMAGE], capture_output=True).returncode != 0:
        return f'{IMAGE} is not present (docker pull {IMAGE})'
    return ''


WHY_NOT = docker_ready()

SCHEMA = r'''
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_app') THEN CREATE ROLE swift_app NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_bypass_rls') THEN CREATE ROLE swift_bypass_rls NOLOGIN NOBYPASSRLS; END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA swift_qr;
CREATE TABLE deployment_identity (environment text NOT NULL, "deploymentId" text NOT NULL);
INSERT INTO deployment_identity VALUES ('staging', 'rehearsal-0001');
CREATE TABLE country_configs (code text PRIMARY KEY);
INSERT INTO country_configs VALUES ('GY');
CREATE TABLE users (id serial PRIMARY KEY, tenant text NOT NULL, name text NOT NULL);
INSERT INTO users (tenant, name) SELECT CASE WHEN g % 2 = 0 THEN 't1' ELSE 't2' END, 'synthetic ' || g FROM generate_series(1, 40) g;
CREATE TABLE vendors (id serial PRIMARY KEY, tenant text NOT NULL);
INSERT INTO vendors (tenant) VALUES ('t1'), ('t2');
CREATE TABLE orders (id serial PRIMARY KEY, tenant text NOT NULL, at geography(Point, 4326));
INSERT INTO orders (tenant, at) SELECT CASE WHEN g % 2 = 0 THEN 't1' ELSE 't2' END, ST_MakePoint(-58.16, 6.80)::geography FROM generate_series(1, 25) g;
CREATE TABLE swift_qr.codes (id serial PRIMARY KEY);
INSERT INTO swift_qr.codes DEFAULT VALUES;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_tenant ON orders TO swift_app USING (tenant = current_setting('app.tenant', true));
GRANT USAGE ON SCHEMA public TO swift_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_app;
GRANT SELECT ON users TO swift_bypass_rls;
'''


@unittest.skipIf(WHY_NOT and not REQUIRED, WHY_NOT)
class RecoverRehearsal(unittest.TestCase):
    def setUp(self):
        if WHY_NOT:
            self.fail(f'SWIFT_REQUIRE_REHEARSAL=1 but {WHY_NOT}')
        self.tag = 'rr' + secrets.token_hex(4)
        self.root = Path(tempfile.mkdtemp(prefix='swift-recover-rehearsal-'))
        self.deploy = self.root / 'deploy'
        self.deploy.mkdir()
        for name in ('restore.sh', 'recover.sh', 'restore-erasure-ledger.sql', 'restore-replay-erasures.sql',
                     'restore-offsite-ledger.sql', 'secret-env.sh', 'backup-signature.py'):
            shutil.copy2(DEPLOY / name, self.deploy / name)
        # The stack's own Compose file. Only two things differ, both for this machine: the secrets
        # directory is the rehearsal's own (no /run/swift-secrets here), and the external network is
        # the project's own private one (two rehearsals never share it).
        compose = (DEPLOY / 'docker-compose.yml').read_text()
        secrets_dir = self.root / 'secrets'
        secrets_dir.mkdir()
        (secrets_dir / 'POSTGRES_PASSWORD').write_text(secrets.token_hex(24))
        (secrets_dir / 'POSTGRES_PASSWORD').chmod(0o444)
        compose = compose.replace('/run/swift-secrets', str(secrets_dir))
        compose = compose.replace('    name: swift-pilot-private\n    external: true\n', '    internal: true\n')
        self.assertNotIn('swift-pilot-private', compose)
        (self.deploy / 'docker-compose.yml').write_text(compose)
        (self.deploy / '.env').write_text('NODE_ENV=production\nPILOT_ENV=staging\nPOSTGRES_DB=swift\nPOSTGRES_USER=swift\n')
        self.projects = []
        self.copy = f'swift_restore_{self.tag}'
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for project in self.projects:
            self.compose(project, 'down', '-v', '--remove-orphans', check=False)
        subprocess.run(['docker', 'rm', '-f', f'swift-restore-{self.copy}'], capture_output=True)
        subprocess.run(['docker', 'volume', 'rm', f'swift-restore-{self.copy}'], capture_output=True)
        shutil.rmtree(self.root, True)

    def compose(self, project, *args, check=True, stdin=None):
        r = subprocess.run(['docker', 'compose', '--project-directory', str(self.deploy), '-f', str(self.deploy / 'docker-compose.yml'),
                            '-p', project, *args], capture_output=True, text=True, input=stdin, timeout=300)
        if check:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def start(self, project):
        self.projects.append(project)
        self.compose(project, 'up', '-d', '--wait', 'postgres')
        # healthy can mean the image's first-start server (socket only): wait for the real one on TCP
        for _ in range(120):
            if self.compose(project, 'exec', '-T', 'postgres', 'pg_isready', '-q', '-h', '127.0.0.1', check=False).returncode == 0:
                return
            time.sleep(1)
        self.fail(f'{project} postgres never accepted TCP connections')

    def psql(self, project, sql, db='swift', user=None):
        script = ('export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -X -h 127.0.0.1 -U "${2:-$POSTGRES_USER}" -d "$1" -v ON_ERROR_STOP=1 -tA'
                  if user is None else 'exec psql -X -h /var/run/postgresql -U "$2" -d "$1" -v ON_ERROR_STOP=1 -tA')
        r = self.compose(project, 'exec', '-T', 'postgres', 'sh', '-c', script, 'sh', db, user or '', stdin=sql, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def counts(self, project):
        return self.psql(project, "SELECT (SELECT count(*) FROM users) || ' ' || (SELECT count(*) FROM orders) || ' ' || (SELECT count(*) FROM swift_qr.codes);")

    def recover(self, project, *args, tty_input=None):
        cmd = ['bash', str(self.deploy / 'recover.sh'), '--project', project, '--from-copy', self.copy, *args]
        env = {k: v for k, v in os.environ.items() if not k.startswith(('POSTGRES_', 'COMPOSE_'))}
        if tty_input is None:
            return subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL, env=env, timeout=600)
        master, slave = pty.openpty()
        try:
            os.write(master, tty_input.encode())
            return subprocess.run(cmd, capture_output=True, text=True, stdin=slave, env=env, timeout=600)
        finally:
            os.close(slave)
            os.close(master)

    def test_from_a_signed_backup_to_a_serving_database_and_back_over_a_damaged_one(self):
        started = time.monotonic()
        old, new = f'{self.tag}-old', f'{self.tag}-new'
        # 1. the old host
        self.start(old)
        self.psql(old, SCHEMA)
        self.psql(old, "DO $$ BEGIN CREATE ROLE swift_app_login LOGIN PASSWORD 'rehearsal-only' IN ROLE swift_app; END $$;", db='postgres')
        before = self.counts(old)
        self.assertEqual(before, '40 25 1')
        # 2. its backup, signed as backup.sh signs it
        dump = self.root / f'swift-20261113T010000Z.dump'
        r = subprocess.run(['docker', 'compose', '--project-directory', str(self.deploy), '-f', str(self.deploy / 'docker-compose.yml'), '-p', old,
                            'exec', '-T', 'postgres', 'sh', '-c', 'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
                           capture_output=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        dump.write_bytes(r.stdout)
        key = self.root / 'signing'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'swift-backup-signing', '-f', str(key)], check=True)
        allowed = self.root / 'allowed_signers'
        allowed.write_text('swift-backup namespaces="swift-backup" ' + ' '.join(Path(f'{key}.pub').read_text().split()[:2]) + '\n')
        subprocess.run([sys.executable, '-I', str(DEPLOY / 'backup-signature.py'), 'sign', '--key', str(key), '--object', str(dump),
                        '--out', f'{dump}.sig', '--created', '20261113T010000Z'], check=True, capture_output=True)
        # 3. the old host is lost, volume and all
        self.compose(old, 'down', '-v')
        # 4. the new host: a fresh cluster, no Swift role at all
        self.start(new)
        self.assertEqual(self.psql(new, "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'swift\\_%';", db='postgres'), '0')
        # 5. restore.sh, disaster mode: a quarantined copy, kept
        env = {k: v for k, v in os.environ.items() if not k.startswith(('BACKUP_', 'POSTGRES_', 'COMPOSE_'))}
        env['BACKUP_SIGNING_ALLOWED_SIGNERS'] = str(allowed)
        r = subprocess.run(['bash', str(self.deploy / 'restore.sh'), '--project', new, '--no-live-ledger', '--i-know-live-is-gone',
                            '--keep-for-inspection', str(dump), self.copy], capture_output=True, text=True, env=env, timeout=600)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn('quarantined, NOT for use', r.stdout)
        # 6. recover.sh: refused without the erasure acknowledgement, then a check, then the promotion
        r = self.recover(new)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--erasures-checked', r.stderr)
        r = self.recover(new, '--erasures-checked', '--check')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('CHECK OK', r.stdout)
        self.assertEqual(self.psql(new, "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'swift\\_%';", db='postgres'), '0', '--check changed nothing')
        r = self.recover(new, '--erasures-checked')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('PROMOTED', r.stdout)
        self.assertIn('every table\'s exact row count equals the copy\'s', r.stdout)
        self.assertEqual(self.counts(new), before)
        # the group roles exactly as the migrations make them: no login, no row-security bypass
        roles = self.psql(new, "SELECT string_agg(format('%s:%s%s%s', rolname, rolcanlogin::int, rolbypassrls::int, rolsuper::int), ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'swift\\_%';", db='postgres')
        self.assertEqual(roles, 'swift_app:000,swift_bypass_rls:000')
        # the runtime login is NOT in a dump: re-created (rls-logins.sh in production), it reads through its policy
        self.psql(new, "CREATE ROLE swift_app_login LOGIN IN ROLE swift_app;", db='postgres')
        self.psql(new, "ALTER ROLE swift_app_login SET app.tenant = 't1';", db='postgres')
        self.assertEqual(self.psql(new, 'SELECT count(*) FROM orders;', user='swift_app_login'), '12')
        self.assertEqual(self.psql(new, 'SELECT count(*) FROM users;', user='swift_app_login'), '40')
        # 7. damage, then recover over the LIVE database
        self.psql(new, 'DELETE FROM orders; DELETE FROM users WHERE id > 5;')
        self.assertEqual(self.counts(new), '5 0 1')
        r = self.recover(new, '--erasures-checked')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('it is LIVE', r.stderr)
        r = self.recover(new, '--erasures-checked', '--replace-database')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('typed at a terminal', r.stderr)
        r = self.recover(new, '--erasures-checked', '--replace-database', tty_input='REPLACE swift\n')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('did not match', r.stderr)
        self.assertEqual(self.counts(new), '5 0 1', 'a refused run changed nothing')
        safety = self.root / 'safety'
        r = self.recover(new, '--erasures-checked', '--replace-database', '--safety-dir', str(safety), tty_input=f'REPLACE swift IN {new}\n')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('PROMOTED', r.stdout)
        self.assertEqual(self.counts(new), before)
        # the damaged database: backed up first (a readable archive, owner-only), and kept renamed and closed
        [backup] = list(safety.glob('swift-before-recover-*.dump'))
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(subprocess.run(['pg_restore', '--list', str(backup)], capture_output=True).returncode, 0)
        kept = self.psql(new, "SELECT datname || ':' || datallowconn FROM pg_database WHERE datname LIKE 'swift\\_replaced\\_%';", db='postgres')
        self.assertRegex(kept, r'^swift_replaced_\d{14}:false$')
        # the login still works on the promoted database (roles are the cluster's, untouched)
        self.assertEqual(self.psql(new, 'SELECT count(*) FROM orders;', user='swift_app_login'), '12')
        print(f'\nrehearsal: backup -> new host -> serving database, then over a damaged live one: {time.monotonic() - started:.0f}s', file=sys.stderr)


if __name__ == '__main__':
    unittest.main()
