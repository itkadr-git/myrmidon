#!/usr/bin/env bash
# Check whether this host satisfies the hard standby prerequisites.
set -u

OS_MIN_MAJOR="${OS_MIN_MAJOR:-22}"
DOCKER_MIN_MAJOR="${DOCKER_MIN_MAJOR:-24}"
POSTGRES_MIN_MAJOR="${POSTGRES_MIN_MAJOR:-14}"
POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
REQUIRED_SECRETS="${REQUIRED_SECRETS:-DATABASE_URL,LITELLM_MASTER_KEY,LITELLM_API_KEY}"
LITELLM_MIRROR_CONFIG="${LITELLM_MIRROR_CONFIG:-}"

failures=0
check() {
  local name="$1" result="$2" detail="$3"
  if [[ "$result" == pass ]]; then
    printf '[PASS] %s: %s\n' "$name" "$detail"
  else
    printf '[FAIL] %s: %s\n' "$name" "$detail"
    failures=$((failures + 1))
  fi
}

version_major() { sed -E 's/[^0-9]*([0-9]+).*/\1/'; }

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
os_id="${ID:-unknown}"
os_version="${VERSION_ID:-}"
os_major="$(printf '%s' "$os_version" | version_major)"
os_minimum="$OS_MIN_MAJOR"
case "$os_id" in
  debian) os_minimum="${DEBIAN_MIN_MAJOR:-12}" ;;
  ubuntu) os_minimum="${UBUNTU_MIN_MAJOR:-22}" ;;
esac
if [[ "$os_major" =~ ^[0-9]+$ ]] && (( os_major >= os_minimum )); then
  check 'OS version' pass "${PRETTY_NAME:-Linux} (minimum major ${os_minimum} for ${os_id})"
else
  check 'OS version' fail "${os_version:-unknown} for ${os_id} (minimum major ${os_minimum})"
fi

docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
docker_major="$(printf '%s' "$docker_version" | version_major)"
if [[ "$docker_major" =~ ^[0-9]+$ ]] && (( docker_major >= DOCKER_MIN_MAJOR )); then
  check 'Docker version' pass "$docker_version (minimum major ${DOCKER_MIN_MAJOR})"
else
  check 'Docker version' fail "${docker_version:-docker unavailable} (minimum major ${DOCKER_MIN_MAJOR})"
fi

pg_version="$(psql --version 2>/dev/null || true)"
pg_major="$(printf '%s' "$pg_version" | version_major)"
if [[ "$pg_major" =~ ^[0-9]+$ ]] && (( pg_major >= POSTGRES_MIN_MAJOR )); then
  check 'PostgreSQL client' pass "$pg_version (minimum major ${POSTGRES_MIN_MAJOR})"
else
  check 'PostgreSQL client' fail "${pg_version:-psql unavailable} (minimum major ${POSTGRES_MIN_MAJOR})"
fi

port_check() {
  local name="$1" host="$2" port="$3"
  if command -v nc >/dev/null 2>&1 && nc -z -w 2 "$host" "$port" >/dev/null 2>&1; then
    check "$name port" pass "$host:$port is reachable"
  elif (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
    exec 3>&-
    check "$name port" pass "$host:$port is reachable"
  else
    check "$name port" fail "$host:$port is not reachable"
  fi
}
port_check 'PostgreSQL' "$POSTGRES_HOST" "$POSTGRES_PORT"
port_check 'LiteLLM' "$LITELLM_HOST" "$LITELLM_PORT"

missing=()
IFS=',' read -r -a secret_names <<< "$REQUIRED_SECRETS"
for secret in "${secret_names[@]}"; do
  [[ -n "${!secret+x}" && -n "${!secret}" ]] || missing+=("$secret")
done
if ((${#missing[@]} == 0)); then
  check 'Secret quorum' pass "${#secret_names[@]} required secrets are set"
else
  check 'Secret quorum' fail "missing: ${missing[*]}"
fi

if [[ -n "$LITELLM_MIRROR_CONFIG" && -r "$LITELLM_MIRROR_CONFIG" ]]; then
  if grep -Eq '(^|[[:space:]])(mirror|api_base|base_url)[[:space:]]*[:=]' "$LITELLM_MIRROR_CONFIG"; then
    check 'LiteLLM mirror config' pass "$LITELLM_MIRROR_CONFIG contains a mirror endpoint"
  else
    check 'LiteLLM mirror config' fail "$LITELLM_MIRROR_CONFIG has no mirror endpoint"
  fi
else
  check 'LiteLLM mirror config' fail "set LITELLM_MIRROR_CONFIG to a readable config file"
fi

if (( failures == 0 )); then
  printf 'Standby readiness: PASS\n'
  exit 0
fi
printf 'Standby readiness: FAIL (%d checks)\n' "$failures"
exit 1
