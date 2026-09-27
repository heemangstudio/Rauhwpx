#!/usr/bin/env bash
# boat 샌드박스가 Cloud 작업을 모두 마치고 설정한 시간 동안 쉬면 스스로 멈춘다.
# rauhwpx-boat-idle.timer가 root로 매분 실행한다. 판단마다 저널에 한 줄을 남기고,
# 설정 파일이 잘못된 경우가 아니면 멈추지 않기로 한 모든 경우에 0으로 끝난다.
#
# `--probe`는 멈추지 않는다. 같은 설정과 같은 탐색으로 이 스크립트가 쓸 자기 중지 수단만
# 찾아 `rauhwpx-boat-self-stop cli|api|none` 한 줄을 출력한다. 데스크톱이 설치 직후 boat
# 명령 API로 부르고, none이면 boat 자동 중지를 유한하게 둔다.
set -uo pipefail

ENV_FILE=/etc/rauhwpx-boat.env
CLOUD_CLI=/usr/local/bin/rauhwpx-cloud
NODE=/opt/rauhwpx-node/bin/node
LOCK_FILE=/run/rauhwpx-boat-idle.lock
STOP_MARKER=/run/rauhwpx-boat-idle.stop-requested
INSTALL_MARKER=/run/rauhwpx-cloud-install.pid
BOOT_GRACE_SECONDS=600
STOP_RETRY_SECONDS=600
DEFAULT_API_URL=https://boat.dev/api/v1
PROBE_ONLY=0
[[ "${1:-}" == --probe ]] && PROBE_ONLY=1

log() {
  if (( PROBE_ONLY )); then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi
}
probe_result() { printf 'rauhwpx-boat-self-stop %s\n' "$1"; }
# 멈추지 않기로 한 판단. 확인 모드에서는 자기 중지 수단이 없다고 알린다.
skip() {
  log "skip: $*"
  (( PROBE_ONLY )) && probe_result none
  exit 0
}

for tool in flock runuser curl; do
  command -v "$tool" >/dev/null || skip "$tool is missing"
done
if (( ! PROBE_ONLY )); then
  exec 9>"$LOCK_FILE" || skip "cannot open $LOCK_FILE"
  flock -n 9 || skip "another idle check is running"
fi

[[ -r "$ENV_FILE" ]] || skip "$ENV_FILE is missing"
SANDBOX_ID=
IDLE_MINUTES=
BOAT_USER=
while IFS='=' read -r key value; do
  case "$key" in
    RAUHWpx_BOAT_SANDBOX_ID) SANDBOX_ID=$value ;;
    RAUHWpx_BOAT_IDLE_MINUTES) IDLE_MINUTES=$value ;;
    RAUHWpx_BOAT_USER) BOAT_USER=$value ;;
  esac
done <"$ENV_FILE"
if [[ ! "$SANDBOX_ID" =~ ^bx_[a-z0-9]{8}$ ]] || [[ ! "$IDLE_MINUTES" =~ ^[0-9]{1,3}$ ]] \
  || (( 10#$IDLE_MINUTES < 5 || 10#$IDLE_MINUTES > 240 )) \
  || [[ ! "$BOAT_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  log "error: $ENV_FILE is invalid; rerun the Cloud installer with RAUHWpx_HOST_KIND=boat"
  (( PROBE_ONLY )) && probe_result none
  exit 1
fi
THRESHOLD=$(( 10#$IDLE_MINUTES * 60 ))

UPTIME=0
if read -r uptime_raw _ </proc/uptime; then UPTIME=${uptime_raw%%.*}; fi
# 아래는 지금 멈출지에 대한 일시적인 판단이다. 확인 모드는 수단만 보므로 건너뛴다.
if (( ! PROBE_ONLY )); then
  # 재개 직후에는 데스크톱이 SSH 터널을 다시 여는 중이다.
  (( UPTIME < BOOT_GRACE_SECONDS )) && skip "booted ${UPTIME}s ago"

  if [[ -f "$STOP_MARKER" ]]; then
    requested=$(stat -c %Y "$STOP_MARKER" 2>/dev/null || echo 0)
    (( $(date +%s) - requested < STOP_RETRY_SECONDS )) && skip "stop was already requested"
  fi

  install_pid=$(cat "$INSTALL_MARKER" 2>/dev/null || true)
  if [[ "$install_pid" =~ ^[0-9]+$ ]] && kill -0 "$install_pid" 2>/dev/null; then
    skip "Cloud installer is running"
  fi
  update_state=$(systemctl show --property=ActiveState --value rauhwpx-cloud-update.service 2>/dev/null || true)
  if [[ "$update_state" == activating || "$update_state" == deactivating ]]; then
    skip "Cloud update is running"
  fi
fi

[[ -x "$CLOUD_CLI" && -x "$NODE" ]] || skip "Rauhwpx Cloud is not installed"

BUSY=1
IDLE_SECONDS=0
RUNNING=0
QUEUED=0
UPLOADS=0
check_idle() {
  local report state has_activity
  report=$(timeout 60 "$CLOUD_CLI" idle --json 2>/dev/null) || return 1
  state=$("$NODE" -e '
    const s = JSON.parse(process.argv[1]);
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    const uploads = s.activeUploads ?? 0;
    if (s.ok !== true || typeof s.busy !== "boolean" || !count(s.idleSeconds)
      || !count(s.runningSessions) || !count(s.queuedSessions) || !count(uploads)) process.exit(1);
    process.stdout.write([s.busy ? 1 : 0, s.idleSeconds, s.lastActivityAt ? 1 : 0,
      s.runningSessions, s.queuedSessions, uploads].join(" "));
  ' "${report##*$'\n'}" 2>/dev/null) || return 1
  read -r BUSY IDLE_SECONDS has_activity RUNNING QUEUED UPLOADS <<<"$state"
  # 재개는 사용자가 깨운 것이다. 멈추기 전의 활동 시각이 아니라 부팅부터 센다.
  if [[ "$has_activity" == 0 ]] || (( IDLE_SECONDS > UPTIME )); then IDLE_SECONDS=$UPTIME; fi
}

if (( ! PROBE_ONLY )); then
  check_idle || skip "Cloud idle check failed"
  if [[ "$BUSY" == 1 ]]; then
    log "busy: $RUNNING running, $QUEUED queued, $UPLOADS uploading"
    exit 0
  fi
  if (( IDLE_SECONDS < THRESHOLD )); then
    log "idle ${IDLE_SECONDS}s of ${THRESHOLD}s"
    exit 0
  fi
fi

USER_HOME=$(getent passwd "$BOAT_USER" | cut -d: -f6)
[[ -n "$USER_HOME" && -d "$USER_HOME" ]] || skip "boat user $BOAT_USER was not found"

# boat가 넣어 주는 PATH와 자격 증명은 사용자 로그인 셸 설정에 있다. Ubuntu의 .bashrc는
# 대화형 셸에서만 끝까지 읽히므로 -i도 준다. 사용자 쪽 명령은 root가 아니라 사용자로 실행한다.
as_boat_user() {
  timeout 60 runuser -u "$BOAT_USER" -- env -i HOME="$USER_HOME" USER="$BOAT_USER" LOGNAME="$BOAT_USER" \
    SHELL=/bin/bash TERM=dumb PATH=/usr/local/bin:/usr/bin:/bin \
    bash -lic "$@" </dev/null 9>&-
}

BOAT_BIN=
MACHINE_ID=
API_URL=
TOKEN=
# shellcheck disable=SC2016 # 사용자 셸이 펼친다.
PROBE='printf "__rauhwpx_boat__ %s %s\n" bin "$(type -P boat)" id "${BOAT_ID:-}" api "${ASCII_API_URL:-}" token "${ASCII_TOKEN:-}"'
while read -r marker key value; do
  [[ "$marker" == __rauhwpx_boat__ ]] || continue
  case "$key" in
    bin) BOAT_BIN=$value ;;
    id) MACHINE_ID=$value ;;
    api) API_URL=$value ;;
    token) TOKEN=$value ;;
  esac
done < <(as_boat_user "$PROBE" 2>/dev/null)
if [[ -z "$BOAT_BIN" ]]; then
  for candidate in "$USER_HOME/.local/bin/boat" "$USER_HOME/bin/boat" "$USER_HOME/.boat/bin/boat" \
    /usr/local/bin/boat /usr/bin/boat /opt/boat/bin/boat; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then BOAT_BIN=$candidate; break; fi
  done
fi
[[ "$BOAT_BIN" == /* && -x "$BOAT_BIN" ]] || BOAT_BIN=
(( ${#TOKEN} <= 4096 )) && [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{16,}$ ]] || TOKEN=

# 포크한 샌드박스는 원본의 설정을 물려받는다. 다른 샌드박스를 멈추지 않는다.
if [[ "$MACHINE_ID" =~ ^bx_[a-z0-9]{8}$ && "$MACHINE_ID" != "$SANDBOX_ID" ]]; then
  skip "this machine is $MACHINE_ID, not the configured $SANDBOX_ID"
fi
if [[ -z "$BOAT_BIN" && -z "$TOKEN" ]]; then
  skip "neither the boat CLI nor ASCII_TOKEN is available to $BOAT_USER"
fi
if (( PROBE_ONLY )); then
  # 아래의 중지 단계와 같은 순서다. CLI가 먼저고, 없으면 ASCII_TOKEN으로 API를 부른다.
  if [[ -n "$BOAT_BIN" ]]; then probe_result cli; else probe_result api; fi
  exit 0
fi

# 사용자 환경을 읽는 사이에 새 작업이 들어왔을 수 있다.
if ! check_idle || [[ "$BUSY" == 1 ]] || (( IDLE_SECONDS < THRESHOLD )); then
  skip "Cloud became active"
fi

CLI_STATUS=
if [[ -n "$BOAT_BIN" ]]; then
  # shellcheck disable=SC2016 # 경로와 ID는 위치 인자로 넘겨 셸 문자열에 섞지 않는다.
  as_boat_user '"$0" stop "$1"' "$BOAT_BIN" "$SANDBOX_ID" >/dev/null 2>&1
  CLI_STATUS=$?
  if [[ "$CLI_STATUS" == 0 ]]; then
    touch "$STOP_MARKER"
    log "stopping $SANDBOX_ID after ${IDLE_SECONDS}s idle via $BOAT_BIN"
    exit 0
  fi
fi

API_CODES=
if [[ -n "$TOKEN" ]]; then
  bases=()
  if [[ "$API_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; then
    bases+=("${API_URL%/}")
    [[ "${API_URL%/}" == */v1 ]] || bases+=("${API_URL%/}/v1")
  fi
  [[ "${API_URL%/}" == "$DEFAULT_API_URL" ]] || bases+=("$DEFAULT_API_URL")
  for base in "${bases[@]}"; do
    # 토큰은 인자 목록에 드러나지 않도록 표준 입력의 curl 설정으로 넘긴다.
    code=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
      | timeout 60 curl --silent --output /dev/null --write-out '%{http_code}' --max-time 45 --config - \
        --request POST --header 'Content-Type: application/json' --data '{}' \
        "$base/sandboxes/$SANDBOX_ID/stop" 9>&-) || true
    code=${code:-000}
    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
      touch "$STOP_MARKER"
      log "stopping $SANDBOX_ID after ${IDLE_SECONDS}s idle via $base"
      exit 0
    fi
    API_CODES+=" $code"
  done
fi

log "stop failed:${CLI_STATUS:+ boat CLI exit $CLI_STATUS}${API_CODES:+ API HTTP$API_CODES}"
exit 0
