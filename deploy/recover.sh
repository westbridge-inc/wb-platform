#!/usr/bin/env bash
# [FABLE-05 3.1] From a verified backup to the SERVING database: promote a kept
# restore copy into the stack's own Postgres, the one the API and worker use.
#
#   ./deploy/recover.sh --project <name> --from-copy <scratch-db> --erasures-checked [--check]
#   ./deploy/recover.sh --project <name> --from-copy <scratch-db> --erasures-checked --replace-database
#
# The copy comes from deploy/restore.sh --keep-for-inspection (on production,
# deploy/backup-drill.sh --recover or --recover-live-gone from the owner's
# computer): the dump's signature verified, restored by a login that is not a
# superuser into a throwaway instance with no network, the erasure ledger
# replayed, quarantined. This script never reads a backup itself: it takes
# only a copy restore.sh made and kept (the instance swift-restore-<scratch>,
# labelled swift.restore=1).
#
# The steps, each refused before anything changes unless it holds:
#   1. --erasures-checked: the operator read the restore's erasure lines for
#      THIS copy (the NOT erasure-complete lines) and dealt with each. The copy
#      becomes what every partner and customer is served; a person erased after
#      the backup must not come back.
#   2. Only the named Compose project's own Postgres is ever written (no guess:
#      live is `swift`, a rehearsal names its own), and only while that
#      project's API, worker and migrate are stopped and no other session is
#      connected to the target database.
#   3. Which deployment: the copy's deployment_identity must be this host's
#      PILOT_ENV, and the same deployment as the database it replaces.
#   4. A target that holds any table is LIVE: replaced only with
#      --replace-database AND the typed confirmation, read from a terminal
#      (never an argument, never a pipe): REPLACE <database> IN <project>.
#   5. Before it is replaced, a fresh backup of it: on production through the
#      hourly backup unit (encrypted to the owner's key, signed, off-site; the
#      run is refused unless the unit succeeds); elsewhere a local custom dump in
#      a private directory, proven readable. And the old database is never
#      dropped: it is RENAMED to <database>_replaced_<utc>, closed to every
#      connection, and kept until a person drops it.
#   6. The roles the dump grants to and a new cluster lacks (a pg_dump of one
#      database carries no role): the group roles the migrations make
#      (swift_app, swift_bypass_rls, swift_owner_wall) are created exactly as the
#      migrations create them. The two runtime logins are never made here: that
#      is deploy/rls-logins.sh (PILOT-RUNBOOK section 13), run after. Any other
#      missing role refuses.
#   7. The copy is dumped and restored into a NEW database in one transaction.
#      Any failure puts the old database back under its own name.
#   8. Every table's exact row count in the promoted database equals the copy's,
#      or the promotion is undone the same way.
#   The hourly backup and erasure-ledger timers are paused from the confirmation
#   to the end of the run (started again whatever the outcome).
#
# --check runs every check and says what it would do; it changes nothing (no
# backup, no rename, no role).
#
# After it: the API is started on the promoted database by the reviewed deploy
# (production: ./deploy/pilot-up.sh --no-public <sha> first, then the whole
# stack once counts and a test order agree; DNS last). PILOT-RUNBOOK section 5b.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
die() { echo "FATAL: $*" >&2; exit 1; }
PROJECT=""
COPY=""
ERASURES_CHECKED=0
REPLACE=0
CHECK_ONLY=0
SAFETY_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) [ $# -ge 2 ] || die "--project needs the Compose project name"; PROJECT="$2"; shift ;;
    --from-copy) [ $# -ge 2 ] || die "--from-copy needs the scratch database name restore.sh kept"; COPY="$2"; shift ;;
    --erasures-checked) ERASURES_CHECKED=1 ;;
    --replace-database) REPLACE=1 ;;
    --check) CHECK_ONLY=1 ;;
    --safety-dir) [ $# -ge 2 ] || die "--safety-dir needs a directory"; SAFETY_DIR="$2"; shift ;;
    *) die "unknown argument $1 (see the header of deploy/recover.sh)" ;;
  esac
  shift
done
[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user (as pilot-up.sh)"
# The terminal is kept for the typed confirmation only (fd 3); every other command reads nothing, so
# no docker call can swallow what the operator types.
exec 3<&0 0</dev/null
[ -n "$PROJECT" ] ||
  die "name the Compose project whose Postgres becomes the serving database: --project <name> (live is 'swift'); recover.sh never guesses. Nothing was changed"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die "--project must be a Compose project name (lowercase letters, digits, - and _)"
[ -n "$COPY" ] || die "name the kept restore copy: --from-copy <scratch-db> (restore.sh printed it). Nothing was changed"
[[ "$COPY" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "--from-copy must be the scratch database name restore.sh used (a lowercase SQL identifier)"
[ "$ERASURES_CHECKED" = 1 ] ||
  die "--erasures-checked is required: read the restore's erasure lines for this copy (every 'NOT erasure-complete' line) and deal with each before it is served. Nothing was changed"

env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' || true
}
DB="$(env_value POSTGRES_DB)"; DB="${DB:-swift}"
OWNER="$(env_value POSTGRES_USER)"; OWNER="${OWNER:-swift}"
PILOT_ENV="$(env_value PILOT_ENV)"
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "POSTGRES_DB must be a lowercase SQL identifier"
[[ "$OWNER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "POSTGRES_USER must be a lowercase SQL identifier"
[ "$COPY" != "$DB" ] || die "the copy cannot be the serving database itself"
if [ "$PILOT_ENV" = production ]; then
  [ "$PROJECT" = swift ] ||
    die "PILOT_ENV=production: the serving database is the 'swift' project's; a rehearsal runs on another host. Nothing was changed"
  [ -z "$SAFETY_DIR" ] ||
    die "PILOT_ENV=production: the safety backup is always the backup unit's (encrypted to the owner's key); --safety-dir is for other hosts. Nothing was changed"
fi
command -v docker >/dev/null 2>&1 || die "Docker is required"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPLACED="${DB}_replaced_$(date -u +%Y%m%d%H%M%S)"
[ "${#REPLACED}" -le 63 ] || die "POSTGRES_DB is too long to keep a replaced copy beside it"
COPY_CTR="swift-restore-$COPY"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" -p "$PROJECT")
TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
PROMOTE_DUMP="$TMP_DIR/promote.dump"
IN_CONTAINER=0
# [REVIEW-2503-A S4-4] The hourly backup and the erasure-ledger shipper are paused for the swap: a dump
# taken mid-restore would upload an EMPTY database as the newest backup, and a heartbeat written into
# the new database would fail the row-count proof. They start again when this run ends, whatever the outcome.
STOPPED_TIMERS=""
cleanup() {
  for timer in $STOPPED_TIMERS; do
    sudo -n systemctl start "$timer" ||
      echo "WARNING: $timer could not be started again: sudo systemctl start $timer (backups stop until it is)" >&2
  done
  rm -rf -- "$TMP_DIR"
  [ "$IN_CONTAINER" = 0 ] || "${COMPOSE[@]}" exec -T postgres rm -f /tmp/swift-promote.dump /tmp/swift-promote-acl.toc >/dev/null 2>&1 ||
    echo "WARNING: remove the promotion dump from the postgres container: docker compose -p $PROJECT exec postgres rm -f /tmp/swift-promote.dump" >&2
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The copy, read as the restore login (it owns the copy and may bypass row security, as the source's owner did).
copy_psql() {
  local database="$1"; shift
  docker exec -i "$COPY_CTR" sh -c \
    "db=\"\$1\"; shift; exec psql -X -h /var/run/postgresql -U $OWNER -d \"\$db\" -v ON_ERROR_STOP=1 \"\$@\"" \
    sh "$database" "$@"
}
# The target: the project's own Postgres, as its owner (the cluster's superuser, as migrations run).
target_psql() {
  local database="$1"; shift
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; db="$1"; shift; exec psql -X -h 127.0.0.1 -U "$POSTGRES_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"' \
    sh "$database" "$@"
}
one() { tr -d '[:space:]'; }

# ── the copy ───────────────────────────────────────────────────────────────
[ "$(docker inspect -f '{{index .Config.Labels "swift.restore"}}' "$COPY_CTR" 2>/dev/null || true)" = 1 ] ||
  die "$COPY_CTR is not a kept restore copy (restore.sh --keep-for-inspection labels it swift.restore=1). Nothing was changed"
[ "$(docker inspect -f '{{.State.Running}}' "$COPY_CTR" 2>/dev/null || true)" = true ] ||
  die "$COPY_CTR is not running: docker start $COPY_CTR, then rerun. Nothing was changed"
[ "$(copy_psql "$COPY" -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;" | one)" = f ] ||
  die "the copy's login is a superuser in $COPY_CTR: this is not an instance restore.sh made. Nothing was changed"
identity_of() {
  local has
  has="$("$1" "$2" -tAc "SELECT to_regclass('public.deployment_identity') IS NOT NULL;" | one)" || return 1
  if [ "$has" != t ]; then echo "none/none"; return 0; fi
  "$1" "$2" -tAc "SELECT coalesce(max(environment), 'none') || '/' || coalesce(max(\"deploymentId\"), 'none') FROM deployment_identity;" | one
}
COPY_IDENTITY="$(identity_of copy_psql "$COPY")" || die "could not read the copy's deployment identity. Nothing was changed"
COPY_TABLES="$(copy_psql "$COPY" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');" | one)" ||
  die "could not read the copy. Nothing was changed"
[ "${COPY_TABLES:-0}" -gt 0 ] 2>/dev/null || die "the copy $COPY holds no table. Nothing was changed"
echo "copy    : $COPY in $COPY_CTR (deployment ${COPY_IDENTITY%%/*})"

# ── the target ─────────────────────────────────────────────────────────────
[ -n "$("${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)" ] ||
  die "the $PROJECT project's postgres is not running: start it (production: ./deploy/pilot-up.sh --data-only <sha> on a new host). Nothing was changed"
for service in api worker migrate; do
  running="$("${COMPOSE[@]}" ps -q "$service")" ||
    die "could not ask Docker whether $service is running; refusing without that answer. Nothing was changed"
  [ -z "$running" ] ||
    die "the $PROJECT project's $service is running: stop it first (docker compose -f deploy/docker-compose.yml stop api worker); a database is never replaced under a serving API. Nothing was changed"
done
EXISTS="$(target_psql postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = '$DB';" | one)" ||
  die "could not reach the $PROJECT project's postgres. Nothing was changed"
TARGET_TABLES=0
TARGET_IDENTITY="none/none"
if [ "$EXISTS" = 1 ]; then
  TARGET_TABLES="$(target_psql "$DB" -tAc "SELECT count(*) FROM pg_tables t WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = format('%I.%I', t.schemaname, t.tablename)::regclass AND d.deptype = 'e');" | one)" ||
    die "could not read the target database $DB. Nothing was changed"
  TARGET_IDENTITY="$(identity_of target_psql "$DB")" || die "could not read the target's deployment identity. Nothing was changed"
fi
echo "target  : $DB in project $PROJECT ($([ "$EXISTS" = 1 ] && echo "$TARGET_TABLES tables, deployment ${TARGET_IDENTITY%%/*}" || echo "absent"))"

# ── which deployment ───────────────────────────────────────────────────────
if [ -n "$PILOT_ENV" ] && [ "$COPY_IDENTITY" != none/none ]; then
  [ "${COPY_IDENTITY%%/*}" = "$PILOT_ENV" ] ||
    die "the copy belongs to the ${COPY_IDENTITY%%/*} deployment and this host is PILOT_ENV=$PILOT_ENV: a backup is only ever served by its own deployment. Nothing was changed"
fi
[ "$PILOT_ENV" != production ] || [ "$COPY_IDENTITY" != none/none ] ||
  die "PILOT_ENV=production: the copy has no deployment identity, so it cannot be proven to be production's. Nothing was changed"
if [ "$TARGET_IDENTITY" != none/none ] && [ "$COPY_IDENTITY" != none/none ]; then
  [ "$TARGET_IDENTITY" = "$COPY_IDENTITY" ] ||
    die "the copy and the database it would replace belong to different deployments: a database is only ever replaced by its own backup. Nothing was changed"
fi

# ── live or empty ──────────────────────────────────────────────────────────
LIVE=0
[ "$EXISTS" = 1 ] && [ "${TARGET_TABLES:-0}" != 0 ] && LIVE=1
if [ "$LIVE" = 1 ] && [ "$REPLACE" = 0 ]; then
  die "the target database $DB holds $TARGET_TABLES tables: it is LIVE. Replacing it needs --replace-database and the typed confirmation; it is backed up and kept (renamed) first. Nothing was changed"
fi
if [ "$EXISTS" = 1 ]; then
  OTHERS="$(target_psql postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();" | one)" ||
    die "could not count the sessions on $DB. Nothing was changed"
  [ "$OTHERS" = 0 ] ||
    die "$OTHERS other session(s) are connected to $DB (an API, a worker, a psql?): close them first. Nothing was changed"
fi

# ── the roles the dump grants to ───────────────────────────────────────────
MIGRATION_ROLES="swift_app swift_bypass_rls swift_owner_wall"
LOGIN_ROLES="swift_app_login swift_system_login"
COPY_ROLES="$(copy_psql "$COPY" -tA <<'SQL'
SELECT DISTINCT r FROM (
  SELECT (aclexplode(c.relacl)).grantee AS g FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL SELECT (aclexplode(nspacl)).grantee FROM pg_namespace WHERE nspacl IS NOT NULL AND nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL SELECT (aclexplode(p.proacl)).grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL SELECT (aclexplode(defaclacl)).grantee FROM pg_default_acl
  UNION ALL SELECT defaclrole FROM pg_default_acl
  UNION ALL SELECT unnest(polroles) FROM pg_policy
) x JOIN LATERAL (SELECT rolname AS r FROM pg_roles WHERE oid = x.g) y ON true
WHERE r NOT LIKE 'pg\_%' AND r <> current_user AND r <> 'swift_restore_admin'
ORDER BY 1;
SQL
)" || die "could not read the roles the copy grants to. Nothing was changed"
TARGET_ROLES="$(target_psql postgres -tAc "SELECT rolname FROM pg_roles ORDER BY 1;")" || die "could not read the target's roles. Nothing was changed"
CREATE_ROLES=""
for role in $COPY_ROLES; do
  grep -qx "$role" <<< "$TARGET_ROLES" && continue
  case " $MIGRATION_ROLES " in
    *" $role "*) CREATE_ROLES="$CREATE_ROLES $role"; continue ;;
  esac
  case " $LOGIN_ROLES " in
    *" $role "*) die "the copy grants to the runtime login $role, which this cluster lacks: logins are made only by deploy/rls-logins.sh. Nothing was changed" ;;
  esac
  [ "$role" != "$OWNER" ] || continue
  die "the copy grants to the role $role, which this cluster lacks and recover.sh does not know how to make; create it as its migration does, then rerun. Nothing was changed"
done
echo "roles   : the copy grants to [$(echo $COPY_ROLES)]; to create here: [$(echo $CREATE_ROLES)]"

if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$LIVE" = 1 ]; then
    echo "CHECK OK: would back up $DB, keep it renamed as $REPLACED (closed to connections), then promote $COPY into a new $DB"
  else
    echo "CHECK OK: would promote $COPY into $DB ($([ "$EXISTS" = 1 ] && echo "an empty database, replaced" || echo "created"))"
  fi
  echo "nothing was changed (--check)"
  exit 0
fi

# ── the typed confirmation ─────────────────────────────────────────────────
if [ "$LIVE" = 1 ]; then
  [ -t 3 ] || die "the confirmation is typed at a terminal, never piped: run recover.sh from an interactive shell. Nothing was changed"
  WANT="REPLACE $DB IN $PROJECT"
  printf 'This replaces the LIVE database %s (project %s) with the copy %s.\nIt is backed up and kept as %s first.\nType exactly: %s\n> ' "$DB" "$PROJECT" "$COPY" "$REPLACED" "$WANT" >&2
  IFS= read -r -u 3 TYPED || TYPED=""
  [ "$TYPED" = "$WANT" ] || die "the confirmation did not match; nothing was changed"
fi

# ── the timers that write to the database, paused ──────────────────────────
if command -v systemctl >/dev/null 2>&1; then
  for timer in swift-backup-hourly.timer swift-erasure-ledger.timer; do
    if systemctl is-active --quiet "$timer" 2>/dev/null; then
      sudo -n systemctl stop "$timer" || die "could not pause $timer (sudo -n systemctl stop $timer); nothing was replaced"
      STOPPED_TIMERS="$STOPPED_TIMERS $timer"
    fi
  done
  [ -z "$STOPPED_TIMERS" ] || echo "paused  :$STOPPED_TIMERS (started again when this run ends, whatever the outcome)"
fi

# ── a fresh backup of what is replaced ─────────────────────────────────────
if [ "$LIVE" = 1 ]; then
  if [ "$PILOT_ENV" = production ]; then
    systemctl cat swift-backup.service >/dev/null 2>&1 ||
      die "PILOT_ENV=production: swift-backup.service is not installed, so the database being replaced cannot be backed up first. Nothing was changed"
    echo "safety backup: sudo systemctl start swift-backup.service (encrypted to the owner's key, signed, off-site)"
    sudo -n systemctl start swift-backup.service ||
      die "the backup of the database being replaced failed (sudo journalctl -u swift-backup.service -n 40); nothing was replaced"
    [ "$(systemctl show -p Result --value swift-backup.service)" = success ] ||
      die "the backup unit did not report success; nothing was replaced"
    NEWEST="$(ls -t /var/backups/swift/swift-*.dump.gpg 2>/dev/null | head -1 || true)"
    echo "safety backup: ${NEWEST##*/} (and off-site; the unit verified it)"
  else
    SAFETY_DIR="${SAFETY_DIR:-$HERE/backups/pre-recover}"
    (umask 077; mkdir -p "$SAFETY_DIR")
    chmod 700 "$SAFETY_DIR"
    SAFETY="$SAFETY_DIR/$DB-before-recover-$STAMP.dump"
    (umask 077
     "${COMPOSE[@]}" exec -T postgres sh -c \
       'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" -Fc' sh "$DB" > "$SAFETY") ||
      { rm -f -- "$SAFETY"; die "the backup of the database being replaced failed; nothing was replaced"; }
    [ -s "$SAFETY" ] && "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$SAFETY" >/dev/null ||
      die "the backup of the database being replaced is not a readable archive; nothing was replaced"
    echo "safety backup: $SAFETY (a plain custom dump, mode 600: it holds everyone's data; remove it once the recovery is accepted)"
  fi
fi

# ── the copy, dumped ───────────────────────────────────────────────────────
(umask 077
 docker exec "$COPY_CTR" pg_dump -h /var/run/postgresql -U "$OWNER" -d "$COPY" -Fc > "$PROMOTE_DUMP") ||
  die "the copy could not be dumped; nothing was replaced"
[ -s "$PROMOTE_DUMP" ] || die "the copy's dump is empty; nothing was replaced"
# Inside the target's own container (owner-only, removed when the run ends): pg_restore needs a file
# it can seek to restore the privileges as their own step.
IN_CONTAINER=1
"${COMPOSE[@]}" exec -T postgres sh -c 'umask 077; cat > /tmp/swift-promote.dump' < "$PROMOTE_DUMP" ||
  die "the copy's dump could not be staged in the postgres container; nothing was replaced"
"${COMPOSE[@]}" exec -T postgres pg_restore --list /tmp/swift-promote.dump > "$TMP_DIR/promote.toc" ||
  die "the copy's dump is not a readable archive; nothing was replaced"
grep -E '^[0-9]+; [0-9]+ [0-9]+ (ACL|DEFAULT ACL) ' "$TMP_DIR/promote.toc" > "$TMP_DIR/acl.toc" || true
"${COMPOSE[@]}" exec -T postgres sh -c 'umask 077; cat > /tmp/swift-promote-acl.toc' < "$TMP_DIR/acl.toc" ||
  die "the privilege list could not be staged in the postgres container; nothing was replaced"

# ── the swap ───────────────────────────────────────────────────────────────
for role in $CREATE_ROLES; do
  # Exactly as the migrations create it (CREATE ROLE <name> NOLOGIN NOBYPASSRLS), and only when absent.
  target_psql postgres -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') THEN CREATE ROLE $role NOLOGIN NOBYPASSRLS; END IF; END \$\$;" ||
    die "the role $role could not be created; nothing was replaced"
  echo "role created: $role (NOLOGIN NOBYPASSRLS, as its migration)"
done
SWAPPED=0
undo() {
  echo "UNDOING: $1" >&2
  target_psql postgres -q -c "DROP DATABASE IF EXISTS \"$DB\";" >&2 ||
    die "$1; AND the half-made $DB could not be dropped: the old database is still kept as $REPLACED (ALTER DATABASE \"$REPLACED\" WITH ALLOW_CONNECTIONS true; ALTER DATABASE \"$REPLACED\" RENAME TO \"$DB\")"
  if [ "$SWAPPED" = 1 ]; then
    target_psql postgres -q -c "ALTER DATABASE \"$REPLACED\" WITH ALLOW_CONNECTIONS true;" -c "ALTER DATABASE \"$REPLACED\" RENAME TO \"$DB\";" >&2 ||
      die "$1; AND the old database could not be put back: it is kept as $REPLACED (ALTER DATABASE \"$REPLACED\" WITH ALLOW_CONNECTIONS true; ALTER DATABASE \"$REPLACED\" RENAME TO \"$DB\")"
    die "$1; the old database was put back as $DB, unchanged"
  fi
  die "$1; $DB was left as it was before (absent or empty)"
}
if [ "$LIVE" = 1 ]; then
  target_psql postgres -q -c "ALTER DATABASE \"$DB\" RENAME TO \"$REPLACED\";" ||
    die "$DB could not be renamed to $REPLACED (a session connected meanwhile?); nothing was replaced"
  SWAPPED=1
  # Kept, closed to every connection (even the owner's) until a person opens or drops it.
  target_psql postgres -q -c "ALTER DATABASE \"$REPLACED\" WITH ALLOW_CONNECTIONS false;" ||
    undo "the replaced database could not be closed to connections"
  echo "kept    : the replaced database as $REPLACED (closed to connections)"
elif [ "$EXISTS" = 1 ]; then
  target_psql postgres -q -c "DROP DATABASE \"$DB\";" || die "the empty database $DB could not be dropped; nothing was replaced"
fi
target_psql postgres -q -c "CREATE DATABASE \"$DB\" OWNER \"$OWNER\" TEMPLATE template0;" ||
  undo "the new database $DB could not be created"
"${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" -d "$1" --exit-on-error --single-transaction --no-owner --no-acl /tmp/swift-promote.dump' \
  sh "$DB" || undo "pg_restore into the new $DB failed (it ran in one transaction, so nothing of it stayed)"
# The privileges, as their own transaction. The copy's instance made its extensions under a short-lived
# role it then dropped (restore.sh), and PostgreSQL 16 keeps that role's number in the extensions'
# initial privileges, so the copy's dump revokes from a role that exists nowhere. Those statements
# (a bare number for a role) are left out and counted; each extension sets its own privileges when the
# restore creates it. Every other grant and revoke is applied, or the promotion is undone.
"${COMPOSE[@]}" exec -T postgres pg_restore -f - -L /tmp/swift-promote-acl.toc /tmp/swift-promote.dump > "$TMP_DIR/acl.sql" ||
  undo "the copy's privileges could not be read"
python3 -I - "$TMP_DIR/acl.sql" "$TMP_DIR/acl-applied.sql" > "$TMP_DIR/acl.skipped" <<'PY' || undo "the copy's privileges could not be filtered"
import re, sys
src, dst = sys.argv[1], sys.argv[2]
dangling = re.compile(r'^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b.*("[0-9]+"|\b(TO|FROM|ROLE) [0-9]+\b)')
skipped = 0
with open(src) as f, open(dst, 'w') as out:
    for line in f:
        if dangling.match(line):
            skipped += 1
            continue
        out.write(line)
print(skipped)
PY
target_psql "$DB" -q -1 < "$TMP_DIR/acl-applied.sql" >/dev/null || undo "the copy's privileges could not be applied"
echo "grants  : the copy's privileges applied ($(cat "$TMP_DIR/acl.skipped") statement(s) naming a dropped role left out)"

# ── proof: every table's exact row count ───────────────────────────────────
COUNTS_SQL="SELECT format('%s.%s %s', table_schema, table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text) FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1;"
COPY_COUNTS="$(copy_psql "$COPY" -tA -c "$COUNTS_SQL")" || undo "the copy's row counts could not be read"
TARGET_COUNTS="$(target_psql "$DB" -tA -c "$COUNTS_SQL")" || undo "the promoted database's row counts could not be read"
if [ "$COPY_COUNTS" != "$TARGET_COUNTS" ]; then
  diff <(printf '%s\n' "$COPY_COUNTS") <(printf '%s\n' "$TARGET_COUNTS") | grep -E '^[<>]' | head -20 >&2 || true
  undo "the promoted database does not hold exactly the copy's rows (< copy, > promoted)"
fi
TABLES="$(printf '%s\n' "$TARGET_COUNTS" | grep -c . || true)"
ROWS="$(printf '%s\n' "$TARGET_COUNTS" | awk '{ s += $2 } END { print s + 0 }')"
echo "compare : $TABLES tables, $ROWS rows: every table's exact row count equals the copy's"
echo "PROMOTED: $COPY is now $DB in project $PROJECT"
if [ "$(env_value TENANT_RLS_BIND)" = 1 ]; then
  echo "next    : the least-privilege logins: ./deploy/rls-logins.sh roles (a NEW host: fingerprint, plan, apply, verify first; PILOT-RUNBOOK section 13)"
fi
echo "next    : start the API on it with the reviewed deploy (production: ./deploy/pilot-up.sh --no-public <sha>, compare counts and one test order, then the whole stack, then DNS)"
echo "next    : remove the copy once the API serves: docker rm -f $COPY_CTR && docker volume rm $COPY_CTR"
[ "$LIVE" = 0 ] || echo "next    : the replaced database $REPLACED holds people erased since; drop it within 24 hours once the recovery is accepted: DROP DATABASE \"$REPLACED\";"
