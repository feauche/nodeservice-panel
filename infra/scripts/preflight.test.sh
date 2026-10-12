#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/nodeservice-preflight-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/panel with spaces/infra"
printf 'SECRET=never-print-this\n' > "$work/panel with spaces/infra/.env"
printf 'services: {}\n' > "$work/panel with spaces/infra/compose.yaml"
cat > "$work/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PREFLIGHT_TEST_LOG"
case "$*" in
  *'BEGIN READ ONLY;'*'COMMIT;'*) printf '{"fixture":1}\n' ;;
  *'ps --status running'*) printf 'postgres running\n' ;;
  *) exit 3 ;;
esac
SH
cat > "$work/bin/systemctl" <<'SH'
#!/usr/bin/env bash
[[ "$1" == list-unit-files ]] || exit 5
printf 'READ-ONLY units\n'
SH
chmod +x "$work/bin/docker" "$work/bin/systemctl"
export PATH="$work/bin:$PATH" PREFLIGHT_TEST_LOG="$work/commands.log"
export NODESERVICE_DIR="$work/panel with spaces"
before=$(cksum "$NODESERVICE_DIR/infra/.env")
bash "$ROOT/infra/scripts/preflight.sh" > "$work/output"
[[ "$before" == "$(cksum "$NODESERVICE_DIR/infra/.env")" ]]
! rg -q 'never-print-this' "$work/output"
[[ $(rg -c 'BEGIN READ ONLY;' "$work/commands.log") -eq 2 ]]
! rg -iq 'INSERT |UPDATE |DELETE |ALTER |DROP |up -d| restart | stop ' "$work/commands.log"
rm "$NODESERVICE_DIR/infra/.env"
if bash "$ROOT/infra/scripts/preflight.sh" > "$work/missing-env" 2>&1; then
  printf 'Missing env was accepted\n' >&2; exit 1
fi
printf 'PASS: only read-only SQL/service inspection; secrets and env preserved; missing installation rejected.\n'
