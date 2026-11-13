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
).replace(
    'if argv[:1] == ["compose"] and "ps" in argv and "-q" in argv:',
    # [REVIEW-2503-A S3-4] the read-only Redis pre-check; [S3-5] an OSRM that answers only after N asks
    'if argv[:1] == ["compose"] and "exec" in argv and "redis" in argv and "info memory" in line:\n'
    '    if os.environ.get("REDIS_USED"): print("used_memory:" + os.environ["REDIS_USED"])\n'
    '    sys.exit(0)\n'
    'if argv[:1] == ["run"] and "osrm:5000" in line and os.environ.get("OSRM_SLOW"):\n'
    '    n = os.environ["CALL_LOG"] + ".osrm"\n'
    '    k = int(open(n).read()) + 1 if os.path.exists(n) else 1\n'
    '    open(n, "w").write(str(k))\n'
    '    sys.exit(0 if k >= int(os.environ["OSRM_SLOW"]) else 1)\n'
    'if argv[:1] == ["compose"] and "ps" in argv and "-q" in argv:',
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
        self.backups = self.tmp / "backups"
        self.backups.mkdir()
        self.store = " ".join(sorted(set(re.findall(r"_FILE: /run/secrets/([A-Z][A-Z0-9_]*)", compose))
                                     | {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}))

    def run_pilot(self, *args, sha=None, **extra):
        sha = sha or self.SHA
        (self.here / ".env").write_text(
            f"PILOT_ENV=staging\nAPI_HOST={API_HOST}\nMAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\n"
            "BACKUP_BUCKET=test-backups\nNODE_ENV=development\nCORS_ORIGIN=https://staging.example.com\n")
        env = os.environ.copy()
        env.update({"PATH": f"{self.bin}:{env['PATH']}", "CALL_LOG": str(self.log), "GIT_HEAD": sha,
                    "STORE_NAMES": self.store, "API_IMAGE": f"swift-api:{PREVIOUS}",
                    "PILOT_UP_ROLLBACK_FILE": str(self.tmp / "rollback-state"), "PILOT_UP_BACKUP_DIR": str(self.backups)})
        env.update(extra)
        result = subprocess.run(["bash", str(self.here / "pilot-up.sh"), *args, sha],
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

    # [REVIEW-2503-A S3-3] A re-run after a failure past the migration must keep pointing at the FIRST
    # pre-migration backup and the revision that served before, never the re-run's own.
    def test_a_rerun_keeps_the_first_rollback_point_and_a_success_clears_it(self):
        import time
        (self.backups / "swift-20261113T080000Z.dump.gpg").write_text("first")
        r1, _ = self.run_pilot(FAIL_ON="up -d --force-recreate migrate")
        self.assertNotEqual(r1.returncode, 0)
        self.assertIn("swift-20261113T080000Z.dump.gpg", r1.stderr)
        time.sleep(1.1)
        (self.backups / "swift-20261113T081500Z.dump.gpg").write_text("after the migration")
        # the failed new API is the one running now
        r2, _ = self.run_pilot(FAIL_ON="up -d --force-recreate migrate", API_IMAGE=f"swift-api:{self.SHA}")
        block = r2.stdout[r2.stdout.index("ROLLBACK"):]
        self.assertIn("swift-20261113T080000Z.dump.gpg", block)
        self.assertNotIn("swift-20261113T081500Z", block)
        self.assertIn(f"./deploy/pilot-up.sh {PREVIOUS}", block)
        self.assertNotIn(f"./deploy/pilot-up.sh {self.SHA}", block)
        self.assertIn("first", block.lower())
        r3, _ = self.run_pilot(API_IMAGE=f"swift-api:{self.SHA}")
        self.assertEqual(r3.returncode, 0, r3.stderr[-800:])
        self.assertFalse((self.tmp / "rollback-state").exists(), "a deploy that reached READY clears the rollback point")

    # [REVIEW-2503-A D-1] The kept point belongs to ONE target. Deploy X fails after its migration; the
    # owner rolls back with the OLD script (which knows nothing of the file); days later deploy Y must
    # name ITS OWN fresh backup, never X's old one.
    def test_a_point_kept_for_another_target_is_discarded_with_a_warning(self):
        import time
        x, y = "c" * 40, "d" * 40
        (self.backups / "swift-20261110T080000Z.dump.gpg").write_text("x's backup")
        r1, _ = self.run_pilot(FAIL_ON="up -d --force-recreate migrate", sha=x)
        self.assertNotEqual(r1.returncode, 0)
        self.assertIn("target=" + x, (self.tmp / "rollback-state").read_text())
        time.sleep(1.1)
        (self.backups / "swift-20261113T090000Z.dump.gpg").write_text("y's own backup")
        # rolled back to the previous good revision by the old script: the API serves PREVIOUS again
        r2, _ = self.run_pilot(FAIL_ON="up -d --force-recreate migrate", sha=y, API_IMAGE=f"swift-api:{PREVIOUS}")
        block = r2.stdout[r2.stdout.index("ROLLBACK"):]
        self.assertIn("swift-20261113T090000Z.dump.gpg", block)
        self.assertNotIn("swift-20261110T080000Z", block)
        self.assertNotIn("FIRST attempt", block)
        self.assertIn("WARNING", r2.stderr)
        self.assertIn(x, r2.stderr, "the warning names the deploy the stale point belonged to")
        self.assertIn("target=" + y, (self.tmp / "rollback-state").read_text())
        # the printout carries the time and the previous good revision
        self.assertRegex(block, r"recorded \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
        self.assertIn(f"previous good revision {PREVIOUS}", block)

    def test_fixing_forward_over_a_broken_target_keeps_its_point(self):
        import time
        x, y = "c" * 40, "d" * 40
        (self.backups / "swift-20261110T080000Z.dump.gpg").write_text("x's backup")
        self.run_pilot(FAIL_ON="up -d --force-recreate migrate", sha=x)
        time.sleep(1.1)
        (self.backups / "swift-20261113T090000Z.dump.gpg").write_text("taken over the migrated database")
        # the broken X is what the API runs: Y fixes forward, and X's point is still the way back
        r2, _ = self.run_pilot(FAIL_ON="up -d --force-recreate migrate", sha=y, API_IMAGE=f"swift-api:{x}")
        block = r2.stdout[r2.stdout.index("ROLLBACK"):]
        self.assertIn("swift-20261110T080000Z.dump.gpg", block)
        self.assertIn("FIRST attempt", block)
        self.assertIn(f"./deploy/pilot-up.sh {PREVIOUS}", block)

    def test_without_a_backup_the_block_says_no_backup_was_taken(self):
        result, _ = self.run_pilot(NO_BACKUP_UNIT="1")
        self.assertIn("NO backup was taken", result.stdout)
        self.assertNotIn("as none", result.stdout)

    # [REVIEW-2503-A S3-5] OSRM is recreated before the API stops and has no healthcheck: its check retries.
    def test_a_slow_routing_engine_is_waited_for(self):
        result, calls = self.run_pilot(OSRM_SLOW="4")
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertGreaterEqual(len([c for c in calls if "osrm:5000" in c and c.startswith("docker run")]), 4)

    def test_a_routing_engine_that_never_answers_is_a_named_fatal_before_anything_stops(self):
        result, calls = self.run_pilot(FAIL_ON="osrm:5000/nearest")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FATAL:", result.stderr)
        self.assertIn("routing engine (OSRM)", result.stderr)
        self.assertFalse([c for c in calls if " stop api worker" in c])

    # [REVIEW-2503-A S3-4] Read-only pre-checks, printed; a Redis already near its new wall refuses.
    def test_the_pre_checks_print_and_a_full_redis_refuses_before_anything_changes(self):
        ok, calls = self.run_pilot(REDIS_USED=str(100 * 1024 * 1024))
        self.assertEqual(ok.returncode, 0, ok.stderr[-800:])
        self.assertIn("pre-check: redis used_memory 100 MB", ok.stdout)
        self.assertIn("pre-check: disk:", ok.stdout)
        self.log.write_text("")
        full, calls = self.run_pilot(REDIS_USED=str(650 * 1024 * 1024))
        self.assertNotEqual(full.returncode, 0)
        self.assertIn("Redis", full.stderr)
        self.assertIn("650 MB", full.stderr)
        self.assertFalse([c for c in calls if " pull " in c or "up -d" in c or " build " in c], calls)

    def test_production_without_the_unit_refuses_in_the_script(self):
        # The production refusal itself, read from the script (a production run needs DNS, keys and
        # timers this harness does not stand up): only the database-only stage may go on without it.
        text = (DEPLOY / "pilot-up.sh").read_text()
        block = text[text.index("if systemctl cat swift-backup.service"):text.index('ROLLBACK_NOTE="ROLLBACK')]
        self.assertIn('[ "$PILOT_ENV" != production ] || [ "$DATA_ONLY" -eq 1 ] ||', block)
        self.assertIn("swift-backup.service is not installed, so no backup can be taken before the migration", block)


if __name__ == "__main__":
    unittest.main()
