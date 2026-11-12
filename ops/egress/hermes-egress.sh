#!/usr/bin/env bash
# Host egress ruleset for Hermes tenant networks.
#
# Every tenant bridge is named hn<12 hex> (see src/modules/runtime/hardening.ts). This script owns one
# iptables chain, HERMES-EGRESS, and jumps to it for `-i hn+` from DOCKER-USER (traffic forwarded out of
# a tenant) and INPUT (traffic from a tenant to the host itself).
#
#   hermes-egress.sh apply  [--dry-run] [--config FILE]   create or refresh the chain and the jumps
#   hermes-egress.sh remove [--dry-run] [--config FILE]   delete the jumps and the chain
#   hermes-egress.sh status [--dry-run] [--config FILE]   show the chain; exit 1 if it or a jump is missing
#
# --dry-run prints every iptables command that would run (one per line, in order) and changes nothing,
# so it needs neither root nor iptables. The config file is parsed, never sourced or executed.
#
# apply validates the whole config first, then loads the chain in ONE atomic iptables-restore
# transaction, so a failure leaves the previous chain untouched (never a half-filled one behind live
# jumps). Tenant IPv6 is switched off with ip6tables DROP rules on INPUT and FORWARD for -i hn+.
# remove is a deliberate, manual operation: nothing in the systemd unit calls it.
set -euo pipefail

CHAIN="HERMES-EGRESS"
IFACE="hn+"
DEFAULT_CONFIG="/etc/hermes-egress/egress.conf"
# Destinations a tenant must never reach (spec 5.2, rule 6).
BLOCKED_RANGES=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4
)

# Defaults; the config file overrides them.
RESOLVERS=""
EXCEPTIONS=""
# PLACEHOLDER until measured on a real host (plan Task 8): not a recommendation.
NEW_CONN_RATE="200/sec"

DRY_RUN=0
CONFIG="$DEFAULT_CONFIG"

die() { printf 'hermes-egress: %s\n' "$*" >&2; exit 1; }
usage() { printf 'usage: hermes-egress.sh <apply|remove|status> [--dry-run] [--config FILE]\n' >&2; exit 2; }

OCTET='(0|[1-9][0-9]{0,2})'
IPV4_RE="^${OCTET}\.${OCTET}\.${OCTET}\.${OCTET}\$"

is_ipv4() {
  local ip="$1" i
  [[ "$ip" =~ $IPV4_RE ]] || return 1
  for i in 1 2 3 4; do
    (( BASH_REMATCH[i] <= 255 )) || return 1
  done
}

is_port() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && (( $1 <= 65535 ))
}

parse_config() {
  local file="$1" line key value lineno=0
  [[ -r "$file" ]] || die "config file not readable: $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || die "config line $lineno is not KEY=VALUE"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    # Only plain tokens: no quoting, expansion or command syntax can survive this.
    [[ "$value" =~ ^[0-9A-Za-z./:\ _-]*$ ]] || die "config line $lineno has characters that are not allowed"
    case "$key" in
      RESOLVERS) RESOLVERS="$value" ;;
      EXCEPTIONS) EXCEPTIONS="$value" ;;
      NEW_CONN_RATE) NEW_CONN_RATE="$value" ;;
      *) die "unknown config key on line $lineno: $key" ;;
    esac
  done < "$file"
}

validate() {
  local r e ip port
  for r in $RESOLVERS; do
    is_ipv4 "$r" || die "RESOLVERS must be space-separated IPv4 addresses"
  done
  for e in $EXCEPTIONS; do
    [[ "$e" == *:* ]] || die "EXCEPTIONS must be space-separated ip:port entries"
    ip="${e%%:*}"
    port="${e#*:}"
    if ! is_ipv4 "$ip" || ! is_port "$port"; then die "EXCEPTIONS must be space-separated ip:port entries"; fi
  done
  [[ "$NEW_CONN_RATE" =~ ^[1-9][0-9]*/(sec|min|hour)$ ]] || die "NEW_CONN_RATE must look like 200/sec (unit sec, min or hour)"
}

# Run (or, with --dry-run, print) one iptables command.
ipt() {
  if (( DRY_RUN )); then
    printf 'iptables -w %s\n' "$*"
  else
    iptables -w "$@"
  fi
}

# Same for ip6tables. Without ip6tables on the host there is nothing to configure: say so and go on.
ipt6() {
  if (( DRY_RUN )); then
    printf 'ip6tables -w %s\n' "$*"
  elif command -v ip6tables >/dev/null 2>&1; then
    ip6tables -w "$@"
  else
    printf 'hermes-egress: ip6tables not found, tenant IPv6 not filtered by this script\n' >&2
  fi
}
has_ip6tables() { command -v ip6tables >/dev/null 2>&1; }

# Quietly test a rule or chain; always succeeds in --dry-run so the commands are printed unconditionally.
chain_exists() { iptables -w -n -L "$CHAIN" >/dev/null 2>&1; }
jump_exists() { iptables -w -C "$1" -i "$IFACE" -j "$CHAIN" >/dev/null 2>&1; }

# Real mode collects the whole chain as one iptables-restore transaction (flushed and refilled
# atomically); --dry-run prints the equivalent iptables commands instead.
RESTORE=""

ensure_chain() {
  if (( DRY_RUN )); then
    ipt -N "$CHAIN"
    ipt -F "$CHAIN"
  else
    RESTORE=":${CHAIN} - [0:0]"$'\n'
  fi
}

load_chain() {
  (( DRY_RUN )) && return 0
  printf '*filter\n%sCOMMIT\n' "$RESTORE" | iptables-restore -w --noflush
}

ensure_jump() {
  local base="$1"
  if (( DRY_RUN )); then
    ipt -I "$base" 1 -i "$IFACE" -j "$CHAIN"
  else
    jump_exists "$base" || ipt -I "$base" 1 -i "$IFACE" -j "$CHAIN"
  fi
}

ensure_ip6_drop() {
  local base="$1"
  if (( DRY_RUN )); then
    ipt6 -I "$base" 1 -i "$IFACE" -j DROP
  elif has_ip6tables; then
    ip6tables -w -C "$base" -i "$IFACE" -j DROP >/dev/null 2>&1 || ipt6 -I "$base" 1 -i "$IFACE" -j DROP
  else
    ipt6 -I "$base" 1 -i "$IFACE" -j DROP
  fi
}

rule() {
  if (( DRY_RUN )); then
    ipt -A "$CHAIN" "$@"
  else
    RESTORE+="-A ${CHAIN} $*"$'\n'
  fi
}

cmd_apply() {
  local r e ip port range num unit
  ensure_chain
  # 1. Return traffic of connections that were already allowed (also the control plane's own health checks).
  rule -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  # 2. DNS to the configured resolvers, so a private resolver keeps working. (Port 53 to a public address
  #    needs no rule: it falls through to RETURN like any public traffic.) Not covered by the cap below.
  for r in $RESOLVERS; do
    rule -p udp -d "$r" --dport 53 -j ACCEPT
    rule -p tcp -d "$r" --dport 53 -j ACCEPT
  done
  # 3. Single ip:port exceptions (empty by default).
  for e in $EXCEPTIONS; do
    ip="${e%%:*}"
    port="${e#*:}"
    rule -p tcp -d "$ip" --dport "$port" -j ACCEPT
  done
  # 4. No outbound SMTP. REJECT so applications fail fast.
  rule -p tcp --dport 25 -j REJECT --reject-with tcp-reset
  # 5. Per-source cap on new connections.
  num="${NEW_CONN_RATE%%/*}"
  unit="${NEW_CONN_RATE#*/}"
  rule -m conntrack --ctstate NEW -m hashlimit --hashlimit-name hermes-newconn \
    --hashlimit-above "${num}/${unit}" --hashlimit-burst "$num" --hashlimit-mode srcip -j DROP
  # 6. Private, link-local (cloud metadata) and other reserved ranges, and the host's own addresses.
  #    The LOCAL match can only ever hit traffic arriving through INPUT: forwarded packets have no local
  #    destination.
  for range in "${BLOCKED_RANGES[@]}"; do
    rule -d "$range" -j REJECT
  done
  rule -m addrtype --dst-type LOCAL -j REJECT
  # 7. Everything else is the public internet. RETURN, not ACCEPT: Docker's own chains (and the host
  #    firewall) must still see this traffic.
  rule -j RETURN
  load_chain
  # Only now send traffic through the finished chain.
  ensure_jump DOCKER-USER
  ensure_jump INPUT
  # IPv6 is off on tenant networks; drop anything that still shows up on a tenant bridge.
  ensure_ip6_drop INPUT
  ensure_ip6_drop FORWARD
}

cmd_remove() {
  local base
  for base in DOCKER-USER INPUT; do
    if (( DRY_RUN )); then
      ipt -D "$base" -i "$IFACE" -j "$CHAIN"
    else
      while jump_exists "$base"; do ipt -D "$base" -i "$IFACE" -j "$CHAIN"; done
    fi
  done
  if (( DRY_RUN )); then
    ipt -F "$CHAIN"
    ipt -X "$CHAIN"
  elif chain_exists; then
    ipt -F "$CHAIN"
    ipt -X "$CHAIN"
  fi
  for base in INPUT FORWARD; do
    if (( DRY_RUN )); then
      ipt6 -D "$base" -i "$IFACE" -j DROP
    elif has_ip6tables; then
      while ip6tables -w -C "$base" -i "$IFACE" -j DROP >/dev/null 2>&1; do ipt6 -D "$base" -i "$IFACE" -j DROP; done
    fi
  done
}

cmd_status() {
  local base missing=0
  if (( DRY_RUN )); then
    ipt -S "$CHAIN"
    ipt -C DOCKER-USER -i "$IFACE" -j "$CHAIN"
    ipt -C INPUT -i "$IFACE" -j "$CHAIN"
    ipt -C "$CHAIN" -m addrtype --dst-type LOCAL -j REJECT
    ipt -C "$CHAIN" -j RETURN
    ipt6 -C INPUT -i "$IFACE" -j DROP
    ipt6 -C FORWARD -i "$IFACE" -j DROP
    return 0
  fi
  if chain_exists; then
    ipt -S "$CHAIN"
    # The chain is loaded atomically, but prove it is whole: its last two rules must be there.
    iptables -w -C "$CHAIN" -m addrtype --dst-type LOCAL -j REJECT >/dev/null 2>&1 || { printf 'MISSING: host-local reject in %s (chain incomplete)\n' "$CHAIN" >&2; missing=1; }
    iptables -w -C "$CHAIN" -j RETURN >/dev/null 2>&1 || { printf 'MISSING: final RETURN in %s (chain incomplete)\n' "$CHAIN" >&2; missing=1; }
  else
    printf 'MISSING: chain %s\n' "$CHAIN" >&2
    missing=1
  fi
  if has_ip6tables; then
    for base in INPUT FORWARD; do
      ip6tables -w -C "$base" -i "$IFACE" -j DROP >/dev/null 2>&1 || { printf 'MISSING: IPv6 drop in %s\n' "$base" >&2; missing=1; }
    done
  else
    printf 'note: ip6tables not found, tenant IPv6 not checked\n' >&2
  fi
  for base in DOCKER-USER INPUT; do
    if jump_exists "$base"; then
      printf 'ok: %s jumps to %s for -i %s\n' "$base" "$CHAIN" "$IFACE"
    else
      printf 'MISSING: jump from %s\n' "$base" >&2
      missing=1
    fi
  done
  return "$missing"
}

main() {
  local sub="${1:-}"
  [[ -n "$sub" ]] || usage
  shift
  while (( $# > 0 )); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --config) [[ $# -ge 2 ]] || usage; CONFIG="$2"; shift ;;
      *) usage ;;
    esac
    shift
  done
  case "$sub" in
    apply|remove|status) ;;
    *) usage ;;
  esac
  if [[ "$sub" == apply ]]; then
    parse_config "$CONFIG"
    validate
  fi
  "cmd_$sub"
}

main "$@"
