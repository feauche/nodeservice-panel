#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/curl" <<'SH'
#!/usr/bin/env bash
cat "$MOCK_GITHUB_JSON"
SH
chmod +x "$TMP/curl"

check_update_source() {
    PATH="$TMP:$PATH" NODESERVICE_UPDATE_LIB=1 MOCK_GITHUB_JSON="$1" bash -c '
      source "$1/infra/scripts/update.sh"
      latest_release_tag
    ' _ "$ROOT"
}

cat > "$TMP/good.json" <<'JSON'
{
  "url": "https://api.github.com/releases/1",
  "tag_name": "v0.55.0",
  "draft": false
}
JSON
[[ "$(check_update_source "$TMP/good.json")" == "v0.55.0" ]]

cat > "$TMP/bad.json" <<'JSON'
{"tag_name":"v0.55.0; touch /tmp/nodeservice-injected"}
JSON
if check_update_source "$TMP/bad.json" >/dev/null 2>&1; then
    echo "опасный тег принят" >&2
    exit 1
fi
[[ ! -e /tmp/nodeservice-injected ]]

# GitHub отвечает не с первого раза: curl падает $1 раз, потом отдаёт файл $2; $3… — функция и её аргументы.
mkdir -p "$TMP/flaky"
cat > "$TMP/flaky/curl" <<'SH'
#!/usr/bin/env bash
n=$(( $(cat "$MOCK_COUNTER" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$MOCK_COUNTER"
(( n > MOCK_FAILS )) || exit 22
cat "$MOCK_BODY"
SH
chmod +x "$TMP/flaky/curl"
flaky() {
    rm -f "$TMP/counter"
    PATH="$TMP/flaky:$PATH" GITHUB_RETRY_PAUSE=0 NODESERVICE_UPDATE_LIB=1 MOCK_COUNTER="$TMP/counter" \
        MOCK_FAILS="$1" MOCK_BODY="$2" bash -c 'source "$1/infra/scripts/update.sh"; shift; "$@"' _ "$ROOT" "${@:3}"
}
# Ответ с третьей попытки — релиз узнаём; три отказа подряд — ошибка, а не пустой тег.
[[ "$(flaky 2 "$TMP/good.json" latest_release_tag)" == "v0.55.0" ]]
[[ "$(cat "$TMP/counter")" == 3 ]]
if flaky 3 "$TMP/good.json" latest_release_tag >/dev/null; then
    echo "три отказа GitHub приняты за ответ" >&2
    exit 1
fi
[[ "$(cat "$TMP/counter")" == 3 ]]
# Файл релиза: SHA256 со второй попытки; не скачался (код 1) и скачался без SHA256 (код 2) — разные ошибки.
ZEROS=$(printf '%064d' 0)
printf 'sha256:%s  ghcr.io/feauche/nodeservice-api:v0.97.0\n' "$ZEROS" > "$TMP/digest.txt"
[[ "$(flaky 1 "$TMP/digest.txt" release_digest https://example.invalid/image-digest.txt)" == "sha256:$ZEROS" ]]
status=0
flaky 3 "$TMP/digest.txt" release_digest https://example.invalid/image-digest.txt >/dev/null || status=$?
[[ "$status" == 1 ]]
echo 'нет хеша' > "$TMP/no-digest.txt"
status=0
flaky 0 "$TMP/no-digest.txt" release_digest https://example.invalid/image-digest.txt >/dev/null || status=$?
[[ "$status" == 2 ]]

extract_backup_name() {
    NODESERVICE_UPDATE_LIB=1 bash -c '
      source "$1/infra/scripts/update.sh"
      backup_name_from_panel_output "$2"
    ' _ "$ROOT" "$1"
}
[[ "$(extract_backup_name 'nodeservice-backup-20261002-151500.tar.gz (18.4 МБ)')" == 'nodeservice-backup-20261002-151500.tar.gz' ]]
[[ "$(extract_backup_name 'nodeservice-backup-20261002-151500.tar.gz.enc (18.4 МБ, с паролем)')" == 'nodeservice-backup-20261002-151500.tar.gz.enc' ]]
if extract_backup_name '$(touch /tmp/nodeservice-backup-injected)' >/dev/null 2>&1; then
    echo "опасное имя копии принято" >&2
    exit 1
fi
[[ ! -e /tmp/nodeservice-backup-injected ]]

# Почему git fetch не удался: ключ просим только при отказе в доступе, а не при любой ошибке.
failure_kind() {
    NODESERVICE_UPDATE_LIB=1 bash -c 'source "$1/infra/scripts/update.sh"; fetch_failure_kind "$2"' _ "$ROOT" "$1"
}
[[ "$(failure_kind "fatal: could not read Username for 'https://github.com': terminal prompts disabled")" == access ]]
[[ "$(failure_kind 'git@github.com: Permission denied (publickey).')" == access ]]
[[ "$(failure_kind 'remote: Repository not found.')" == access ]]
[[ "$(failure_kind ' ! [rejected]        v0.106.3   -> v0.106.3  (would clobber existing tag)')" == other ]]
[[ "$(failure_kind 'fatal: unable to access: Could not resolve host: github.com')" == other ]]
grep -Fq 'LC_ALL=C git fetch' "$ROOT/infra/scripts/update.sh"

# Метку перенесли на GitHub (выпуск переделан): сервер, скачавший её раньше, обновляется без ошибки.
if command -v git >/dev/null; then
    export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    git init -q -b main "$TMP/origin"
    git -C "$TMP/origin" commit -q --allow-empty -m first
    git -C "$TMP/origin" tag v1.0.0
    git clone -q "$TMP/origin" "$TMP/server"
    git -C "$TMP/origin" commit -q --allow-empty -m second
    git -C "$TMP/origin" tag -f v1.0.0 >/dev/null
    moved=$(git -C "$TMP/origin" rev-parse v1.0.0)
    if git -C "$TMP/server" fetch --all --tags --prune --quiet 2>/dev/null; then
        echo "git без --force обновил перенесённую метку — проверка больше не воспроизводит ошибку" >&2
        exit 1
    fi
    (cd "$TMP/server" && NODESERVICE_UPDATE_LIB=1 bash -c 'source "$1/infra/scripts/update.sh"; fetch_code' _ "$ROOT")
    [[ "$(git -C "$TMP/server" rev-parse v1.0.0)" == "$moved" ]]
fi

bash -n "$ROOT/infra/scripts/install.sh" "$ROOT/infra/scripts/update.sh" "$ROOT/infra/scripts/nodeservice"
grep -Fq 'docker pull "$release_image"' "$ROOT/infra/scripts/update.sh"
grep -Fq 'org.opencontainers.image.revision' "$ROOT/infra/scripts/update.sh"
grep -Fq 'image-digest.txt' "$ROOT/infra/scripts/update.sh"
grep -Fq 'image_digest" != "$expected_digest' "$ROOT/infra/scripts/update.sh"
grep -Fq 'nodeservice-api:${{ github.ref_name }}' "$ROOT/.github/workflows/release.yml"
echo "release-source-ok"
