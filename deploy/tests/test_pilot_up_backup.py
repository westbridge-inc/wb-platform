"""[FABLE-05 3.8] pilot-up.sh takes a backup before it migrates, and says how to
go back. The real script, end to end, against the same shims as the website
tests (docker, git, curl, sudo, systemctl, the secret store, sleep): nothing is
deployed.

  - with the backup unit installed: the backup runs after every check and
    before the running API is stopped; a failed backup stops the deploy with
    nothing stopped or migrated;
  - the rollback is printed before the migration (the backup's name and the
    revision the API served), and again with any refusal after it;
  - production without the unit refuses (its hourly timer is required anyway);
    another host without it warns and goes on."""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_stg_ops import API_HOST, FAKE_PILOT_DOCKER, sh_shim

DEPLOY = Path(__file__).resolve().parents[1]
PREVIOUS = "b" * 40

# The website tests' docker, which also names the image the running API was started from.
FAKE_DOCKER = FAKE_PILOT_DOCKER.replace(
    '    else:\n        print("running")\n',
    '    elif "Config.Image" in fmt:\n        print(os.environ.get("API_IMAGE", ""))\n    else:\n        print("running")\n',
)
assert FAKE_DOCKER != FAKE_PILOT_DOCKER

SYSTEMCTL = '''echo "systemctl $*" >> "$CALL_LOG"
case "$1" in
  cat) [ -z "$NO_BACKUP_UNIT" ] || exit 1 ;;
  start) [ "$2" != swift-backup.service ] || [ -z "$BACKUP_FAILS" ] || exit 3 ;;
esac
exit 0'''


class PilotUpBacksUpBeforeMigrating(unittest.TestCase):
    SHA = "c" * 40

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-pilot-backup-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.here = self.tmp / "repo" / "deploy"
        (self.here / "routing-data" / "osrm").mkdir(parents=True)
        (self.here / "routing-data" / "osrm" / "guyana-latest.osrm").write_text("")
        for name in ("pilot-up.sh", "secret-names.sh", "wait-for-migration.sh", "verify-journeys-isolation.py", "check-upload-storage.py",
                     "Caddyfile", "docker-compose.yml", "docker-compose.routing.yml"):
            shutil.copy(DEPLOY / name, self.here / name)
        utils = self.tmp / "repo" / "apps" / "api" / "src" / "utils"
        utils.mkdir(parents=True)
        shutil.copy(DEPLOY.parent / "apps" / "api" / "src" / "utils" / "secret-files.ts", utils / "secret-files.ts")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls"
        self.log.write_text("")
        (self.bin / "docker").write_text(FAKE_DOCKER)
        (self.bin / "docker").chmod(0o755)
        sh_shim(self.bin, "git", 'echo "git $*" >> "$CALL_LOG"\n[ "$*" = "rev-parse HEAD" ] && echo "$GIT_HEAD"\nexit 0')
        sh_shim(self.bin, "curl", 'echo "curl $*" >> "$CALL_LOG"\nexit 0')
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        sh_shim(self.bin, "sudo", 'echo "sudo $*" >> "$CALL_LOG"\n[ "$1" = -n ] && shift\nexec "$@"')
        sh_shim(self.bin, "swift-secrets", '[ "$1" = list ] && printf "%s\\n" $STORE_NAMES\nexit 0')
        sh_shim(self.bin, "systemctl", SYSTEMCTL)
        sh_shim(self.bin, "sleep", "exit 0")
        compose = (DEPLOY / "docker-compose.yml").read_text()
        self.store = " ".join(sorted(set(re.findall(r"_FILE: /run/secrets/([A-Z][A-Z0-9_]*)", compose))
                                     | {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}))

    def run_pilot(self, *args, **extra):
        (self.here / ".env").write_text(
            f"PILOT_ENV=staging\nAPI_HOST={API_HOST}\nMAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\n"
            "BACKUP_BUCKET=test-backups\nNODE_ENV=development\nCORS_ORIGIN=https://staging.example.com\n")
        env = os.environ.copy()
        env.update({"PATH": f"{self.bin}:{env['PATH']}", "CALL_LOG": str(self.log), "GIT_HEAD": self.SHA,
                    "STORE_NAMES": self.store, "API_IMAGE": f"swift-api:{PREVIOUS}"})
        env.update(extra)
        result = subprocess.run(["bash", str(self.here / "pilot-up.sh"), *args, self.SHA],
                                env=env, text=True, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
        return result, self.log.read_text().splitlines()

    @staticmethod
    def first(calls, fragment):
        return next(i for i, call in enumerate(calls) if fragment in call)

    def test_the_backup_runs_after_every_check_and_before_the_api_stops(self):
        result, calls = self.run_pilot()
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        backup = self.first(calls, "sudo -n systemctl start swift-backup.service")
        self.assertLess(self.first(calls, "build api"), backup)
        self.assertLess(self.first(calls, "--network swift_scanner"), backup, "after the scanner proof")
        self.assertLess(backup, self.first(calls, " stop api worker"))
        self.assertLess(backup, self.first(calls, "up -d --force-recreate migrate"))
        # the way back, printed before the migration: the revision the API served and the backup
        self.assertIn("ROLLBACK:", result.stdout)
        self.assertIn(f"./deploy/pilot-up.sh {PREVIOUS}", result.stdout)
        self.assertIn("deploy/recover.sh", result.stdout)

    def test_a_failed_backup_stops_the_deploy_before_anything_is_stopped_or_migrated(self):
        result, calls = self.run_pilot(BACKUP_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("the backup before the migration failed", result.stderr)
        self.assertFalse([c for c in calls if " stop api worker" in c], calls)
        self.assertFalse([c for c in calls if "migrate" in c and "up -d" in c], calls)

    def test_a_refusal_after_the_migration_starts_repeats_the_way_back(self):
        result, _ = self.run_pilot(FAIL_ON="up -d --force-recreate migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROLLBACK:", result.stderr)
        self.assertIn(f"./deploy/pilot-up.sh {PREVIOUS}", result.stderr)

    def test_a_refusal_before_the_backup_names_no_rollback(self):
        result, _ = self.run_pilot(FAIL_ON="build api")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("ROLLBACK:", result.stderr)

    def test_without_the_unit_another_host_warns_and_goes_on(self):
        result, calls = self.run_pilot(NO_BACKUP_UNIT="1")
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertIn("no backup is taken before the migration", result.stderr)
        self.assertFalse([c for c in calls if "systemctl start swift-backup.service" in c])

    def test_production_without_the_unit_refuses_in_the_script(self):
        # The production refusal itself, read from the script (a production run needs DNS, keys and
        # timers this harness does not stand up): only the database-only stage may go on without it.
        text = (DEPLOY / "pilot-up.sh").read_text()
        block = text[text.index("if systemctl cat swift-backup.service"):text.index('ROLLBACK_NOTE="ROLLBACK:')]
        self.assertIn('[ "$PILOT_ENV" != production ] || [ "$DATA_ONLY" -eq 1 ] ||', block)
        self.assertIn("swift-backup.service is not installed, so no backup can be taken before the migration", block)


if __name__ == "__main__":
    unittest.main()
