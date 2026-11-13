"""[FABLE-05 3.4 · 3.5 · 3.11] The stack's own limits, read from the rendered Compose
configuration (client-side: `docker compose config`, no daemon state changes).

  - every service, in both files, logs with a size limit; the API, worker,
    Redis, search, Caddy and routing have a memory ceiling; Postgres has none
    on purpose and is last in the kernel's line for a kill;
  - Postgres and search mount their own secret only, never the directory;
    search runs as uid 1000 after a one-shot hands its volume over;
  - STACK_HARDENING=1 (docker-compose.hardening.yml and its companions): Caddy,
    the website and the console are on the edge network only; the data network
    holds Postgres, Redis, search, the migration and the API and worker;
    routing is on its own network with the API and worker; Redis needs its
    password; the private journeys instance may join routing, the runner never.
  - pilot-up.sh: the setting is 1, 0 or empty; the Redis pair must be in the
    store; the edge network must lie inside TRUST_PROXY."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1]


def render(*files, profiles=("web", "admin"), node_env="production"):
    work = Path(tempfile.mkdtemp(prefix="swift-hardening-render-"))
    try:
        for f in DEPLOY.glob("docker-compose*.yml"):
            shutil.copy(f, work / f.name)
        shutil.copy(DEPLOY / "Caddyfile", work / "Caddyfile")
        (work / ".env").write_text(f"NODE_ENV={node_env}\nAPI_HOST=api.example.com\n")
        cmd = ["docker", "compose", "--project-directory", str(work)]
        for f in files:
            cmd += ["-f", str(work / f)]
        for p in profiles:
            cmd += ["--profile", p]
        env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
        r = subprocess.run(cmd + ["config", "--format", "json"], capture_output=True, text=True, env=env, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr)
        return json.loads(r.stdout)
    finally:
        shutil.rmtree(work, True)


def nets(model, service):
    declared = model.get("networks") or {}
    attached = model["services"][service].get("networks") or {}
    return sorted((declared.get(k) or {}).get("name", k) for k in attached)


@unittest.skipUnless(shutil.which("docker"), "docker CLI is required to render Compose")
class TheStackItsLimits(unittest.TestCase):
    def test_every_service_logs_with_a_size_limit(self):
        # Every limit is in the BASE file; the hardening overlay may add to it, never make one opt-in.
        for files, profiles in ((("docker-compose.yml",), ("web", "admin")),
                                (("docker-compose.yml", "docker-compose.hardening.yml"), ("web", "admin")),
                                (("docker-compose.routing.yml",), ("planner", "geocoding"))):
            model = render(*files, profiles=profiles)
            for name, svc in model["services"].items():
                with self.subTest(service=name, files=files):
                    log = svc.get("logging") or {}
                    self.assertEqual(log.get("driver"), "json-file")
                    self.assertEqual(log.get("options"), {"max-size": "50m", "max-file": "5"})

    def test_memory_ceilings_and_the_database_protected(self):
        for files in (("docker-compose.yml",), ("docker-compose.yml", "docker-compose.hardening.yml")):
            s = render(*files)["services"]
            for name in ("api", "worker", "redis", "meilisearch", "caddy", "clamd", "web", "admin"):
                with self.subTest(service=name, files=files):
                    self.assertTrue(s[name].get("mem_limit"), f"{name} has no memory ceiling")
            self.assertNotIn("mem_limit", s["postgres"])
            self.assertEqual(s["postgres"].get("oom_score_adj"), -500)
            self.assertIn("--maxmemory 768mb", " ".join(s["redis"]["command"]))
        self.assertEqual(render("docker-compose.routing.yml")["services"]["osrm"].get("mem_limit"), str(1024 ** 3))

    def test_postgres_and_search_mount_their_own_secret_only(self):
        s = render("docker-compose.yml")["services"]
        for name, secret in (("postgres", "POSTGRES_PASSWORD"), ("meilisearch", "MEILISEARCH_KEY")):
            with self.subTest(service=name):
                binds = [v for v in s[name].get("volumes", []) if v.get("type") == "bind"]
                self.assertEqual([(v["source"], v["target"], v.get("read_only")) for v in binds],
                                 [(f"/run/swift-secrets/{secret}", f"/run/secrets/{secret}", True)])
        self.assertEqual(s["meilisearch"].get("user"), "1000:1000")
        owner = s["meilisearch-data-owner"]
        self.assertEqual(owner.get("network_mode"), "none")
        self.assertEqual([v["source"] for v in owner.get("volumes", [])], ["swift-meilidata"])
        self.assertEqual(s["meilisearch"]["depends_on"]["meilisearch-data-owner"]["condition"], "service_completed_successfully")

    def test_without_the_setting_the_stack_is_as_it_was(self):
        model = render("docker-compose.yml")
        for name in ("caddy", "web", "admin", "redis", "postgres"):
            self.assertEqual(nets(model, name), ["swift-pilot-private"], name)
        self.assertNotIn("REDIS_URL_FILE", model["services"]["api"]["environment"])
        # Redis needs no password without the setting
        self.assertNotIn("requirepass", " ".join(model["services"]["redis"]["command"]))

    def test_hardened_networks(self):
        model = render("docker-compose.yml", "docker-compose.hardening.yml")
        for name in ("caddy", "web", "admin"):
            self.assertEqual(nets(model, name), ["swift-pilot-edge"], name)
        for name in ("postgres", "redis", "meilisearch", "migrate"):
            self.assertEqual(nets(model, name), ["swift-pilot-private"], name)
        self.assertEqual(nets(model, "api"), sorted(["swift-pilot-private", "swift_scanner", "swift-pilot-edge", "swift-pilot-routing"]))
        self.assertEqual(nets(model, "worker"), sorted(["swift-pilot-private", "swift_scanner", "swift-pilot-routing"]))
        routing = render("docker-compose.routing.yml", "docker-compose.routing.hardening.yml", profiles=("planner", "geocoding"))
        for name in routing["services"]:
            self.assertEqual(nets(routing, name), ["swift-pilot-routing"], name)

    def test_the_overlay_never_takes_a_base_protection_away(self):
        base = render("docker-compose.yml")["services"]
        hard = render("docker-compose.yml", "docker-compose.hardening.yml")["services"]
        self.assertEqual(hard["postgres"]["volumes"], base["postgres"]["volumes"])
        for name in base:
            for key in ("logging", "mem_limit", "oom_score_adj", "user"):
                if key in base[name]:
                    self.assertEqual(hard[name].get(key), base[name][key], f"{name}.{key}")

    def test_hardened_redis_needs_its_password_and_never_on_argv(self):
        s = render("docker-compose.yml", "docker-compose.hardening.yml")["services"]
        redis = s["redis"]
        script = " ".join(redis["command"])
        self.assertIn("requirepass", script)
        self.assertIn("/run/redis-auth/auth.conf", script)
        self.assertNotIn("--requirepass", script)
        self.assertEqual([t.split(":")[0] for t in redis.get("tmpfs", [])], ["/run/redis-auth"])
        self.assertIn("REDISCLI_AUTH=", " ".join(redis["healthcheck"]["test"]))
        for name in ("api", "worker"):
            env = s[name]["environment"]
            self.assertEqual(env.get("REDIS_URL"), "")
            self.assertEqual(env.get("REDIS_URL_FILE"), "/run/secrets/REDIS_URL")

    def test_journeys_under_hardening_may_reach_routing_and_the_runner_never(self):
        model = render("docker-compose.yml", "docker-compose.hardening.yml", "docker-compose.journeys.yml",
                       "docker-compose.journeys.hardening.yml", profiles=("journeys",), node_env="loadtest")
        self.assertEqual(nets(model, "api-journeys"), sorted(["swift-pilot-private", "swift_scanner", "swift-pilot-routing"]))
        self.assertEqual(model["services"]["api-journeys"]["environment"].get("REDIS_URL_FILE"), "/run/secrets/REDIS_URL")
        caddyfile = (DEPLOY / "Caddyfile").read_text()
        r = subprocess.run([sys.executable, str(DEPLOY / "verify-journeys-isolation.py"), str(DEPLOY / "Caddyfile"), "--require-journeys"],
                           input=json.dumps(model), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        # the runner on routing is refused
        model["services"]["journeys"]["networks"] = {"private": None, "routing": None}
        r = subprocess.run([sys.executable, str(DEPLOY / "verify-journeys-isolation.py"), str(DEPLOY / "Caddyfile"), "--require-journeys"],
                           input=json.dumps(model), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue(caddyfile)


class PilotUpSetting(unittest.TestCase):
    """The setting and the edge range, read from the script (a full hardened run needs a daemon)."""

    def test_the_setting_is_one_zero_or_empty_and_adds_the_overlays(self):
        text = (DEPLOY / "pilot-up.sh").read_text()
        block = text[text.index('case "$(env_setting STACK_HARDENING)" in'):]
        block = block[:block.index("esac")]
        self.assertIn('COMPOSE+=(-f "$HERE/docker-compose.hardening.yml"); ROUTING+=(-f "$HERE/docker-compose.routing.hardening.yml")', block)
        self.assertIn('die "STACK_HARDENING must be 1, 0 or empty"', block)
        # the Redis pair is required in the store, and the probes use the routing network
        self.assertIn("/run/secrets/REDIS_PASSWORD", text)
        self.assertIn('docker run --rm --network "$ROUTING_NET"', text)
        journeys = (DEPLOY / "journeys-run.sh").read_text()
        self.assertIn("docker-compose.journeys.hardening.yml", journeys)

    def test_the_edge_range_must_lie_inside_trust_proxy(self):
        text = (DEPLOY / "pilot-up.sh").read_text()
        start = text.index("python3 -I -c '\nimport ipaddress")
        code = text[text.index("'", start) + 1:text.index("' \"$(env_setting TRUST_PROXY)\"", start)]
        def check(trust, ranges):
            return subprocess.run([sys.executable, "-I", "-c", code, trust, ranges], capture_output=True).returncode
        self.assertEqual(check("loopback, 172.16.0.0/12", "172.22.0.0/16"), 0)
        self.assertNotEqual(check("loopback, 172.16.0.0/12", "192.168.16.0/20"), 0)
        self.assertNotEqual(check("loopback", "172.22.0.0/16"), 0)
        self.assertNotEqual(check("loopback, 172.16.0.0/12", ""), 0)


if __name__ == "__main__":
    unittest.main()
