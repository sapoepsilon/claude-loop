#!/usr/bin/env bash
#
# provision-proxmox.sh — one command to stand up a Debian LXC on a Proxmox host
# with a working headless Claude Code (claude CLI driven via tmux).
#
# Usage:
#   ./provision-proxmox.sh <proxmox-ssh-target> [ctid]
#
# Examples:
#   ./provision-proxmox.sh root@<proxmox-host>
#   ./provision-proxmox.sh root@<proxmox-host> 133
#
# Credential resolution (in order):
#   1. $CLAUDE_CODE_OAUTH_TOKEN env var (portable, preferred for real servers)
#   2. macOS Keychain "Claude Code-credentials" (works when run from your Mac)
#
# The script is idempotent on the given CTID: if it already exists it is destroyed
# and recreated, so re-running gives a clean box.

set -euo pipefail

RECREATE=0
FORCE_CREDENTIAL=0
CONFIGURE_ONLY=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    --force-credential) FORCE_CREDENTIAL=1 ;;
    --configure-only) CONFIGURE_ONLY=1 ;;
    --*) printf 'unknown flag: %s\n' "$arg" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
PROXMOX="${POSITIONAL[0]:?usage: provision-proxmox.sh [--recreate] [--force-credential] <proxmox-ssh-target> [ctid]}"
CTID_ARG="${POSITIONAL[1]:-}"

TEMPLATE_GREP="debian-13-standard"
BRIDGE="vmbr0"
STORAGE="local-lvm"
DISK_GB="20"
CORES="4"
MEM_MB="4096"

say() { printf '\033[36m[provision]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[provision] error:\033[0m %s\n' "$*" >&2; exit 1; }

# remote: no stdin (-n) so `curl ... | bash` can't have ssh slurp the piped script.
# remote_in: for the calls that deliberately feed stdin (heredoc / credential pipe).
remote() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$PROXMOX" "$@"; }
remote_in() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$PROXMOX" "$@"; }

# ---- credential -------------------------------------------------------------
CRED_MODE=""
resolve_credential_mode() {
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    CRED_MODE="token"
  elif command -v security >/dev/null 2>&1 && \
       security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1; then
    CRED_MODE="keychain"
  else
    die "no credential — set CLAUDE_CODE_OAUTH_TOKEN or run from a Mac logged into Claude Code"
  fi
  say "credential source: $CRED_MODE"
}

# ---- container lifecycle ----------------------------------------------------
pick_ctid() {
  if [[ -n "$CTID_ARG" ]]; then CTID="$CTID_ARG"; else CTID="$(remote pvesh get /cluster/nextid)"; fi
  say "target CTID: $CTID"
}

create_container() {
  local template
  template="$(remote "pveam list local | awk '/$TEMPLATE_GREP/{print \$1; exit}'")"
  [[ -n "$template" ]] || die "no $TEMPLATE_GREP template on host (run: pveam available; pveam download local <tmpl>)"
  say "template: $template"

  if remote "pct status $CTID >/dev/null 2>&1"; then
    [[ "$RECREATE" == "1" ]] || die "CT $CTID already exists — refusing to clobber it. Pass --recreate to destroy+rebuild, or give a fresh CTID. To keep an existing box, don't use this (destructive) script."
    say "--recreate: destroying existing CT $CTID"
    remote "pct stop $CTID >/dev/null 2>&1 || true; pct destroy $CTID --force --purge"
  fi

  say "creating + starting container $CTID"
  remote "pct create $CTID '$template' \
      --hostname claude-runner-$CTID \
      --cores $CORES --memory $MEM_MB --swap 512 \
      --rootfs $STORAGE:$DISK_GB \
      --net0 name=eth0,bridge=$BRIDGE,ip=dhcp \
      --features nesting=1 --unprivileged 1 --ostype debian --onboot 0 \
      --description 'claude-loop runner' >/dev/null
    pct start $CTID"

  say "waiting for network..."
  remote "for i in \$(seq 1 30); do pct exec $CTID -- getent hosts deb.debian.org >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1" \
    || die "container never got working DNS/network"
}

# ---- in-container bootstrap (generic, no secrets) ---------------------------
bootstrap_container() {
  say "installing toolchain (tmux, node 22, claude) — ~2 min"
  remote_in "pct exec $CTID -- bash -s" <<'BOOTSTRAP'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git tmux locales >/dev/null
sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen en_US.UTF-8 >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
echo "export IS_SANDBOX=1" > /etc/profile.d/claude-loop.sh
mkdir -p /root/.claude

# claude-smoke: launch claude in tmux, auto-clear the one-time trust + bypass
# gates, send a prompt, and confirm the model answered (token seen twice = echoed
# input + the model's reply).
cat > /usr/local/bin/claude-smoke <<'SMOKE'
#!/usr/bin/env bash
set -euo pipefail
SOCK=clsmoke
TOKEN="PROVISION_OK_$$"
tmux -L $SOCK kill-server 2>/dev/null || true
tmux -L $SOCK new-session -d -s t -x 220 -y 50 -e IS_SANDBOX=1 -c /root "claude --permission-mode bypassPermissions"
sent=0
pane=""
for _ in $(seq 1 45); do
  sleep 2
  pane="$(tmux -L $SOCK capture-pane -pt t -S -80 2>/dev/null || true)"
  if [ "$(printf '%s' "$pane" | grep -c "$TOKEN")" -ge 2 ]; then
    echo "SMOKE_PASS"; tmux -L $SOCK kill-server 2>/dev/null || true; exit 0
  fi
  if printf '%s' "$pane" | grep -q "I trust this folder"; then
    tmux -L $SOCK send-keys -t t Enter; continue
  fi
  if printf '%s' "$pane" | grep -q "Yes, I accept"; then
    tmux -L $SOCK send-keys -t t Down; sleep 1; tmux -L $SOCK send-keys -t t Enter; continue
  fi
  if [ "$sent" -eq 0 ] && printf '%s' "$pane" | grep -q "shift+tab to cycle"; then
    tmux -L $SOCK send-keys -t t "Reply with exactly this token and nothing else: $TOKEN"; sleep 1
    tmux -L $SOCK send-keys -t t Enter; sent=1; continue
  fi
done
echo "SMOKE_FAIL"; printf '%s\n' "$pane" | tail -25
tmux -L $SOCK kill-server 2>/dev/null || true
exit 1
SMOKE
chmod +x /usr/local/bin/claude-smoke
echo "bootstrap-done"
BOOTSTRAP
}

# ---- push credential (secret; piped, never in argv) -------------------------
push_credential() {
  # Preserve an existing WORKING login. Overwriting a box that already authed —
  # especially under the same account — risks an OAuth refresh-token rotation war
  # (both machines share one token family and log each other out on refresh).
  if [[ "$FORCE_CREDENTIAL" != "1" ]] && \
     remote "pct exec $CTID -- bash -lc 'test -s /root/.claude/.credentials.json && IS_SANDBOX=1 timeout 60 claude -p ok --permission-mode bypassPermissions >/dev/null 2>&1'"; then
    say "target already has a WORKING claude login — preserving it (pass --force-credential to override)"
    return 0
  fi
  # back up whatever is there before writing
  remote "pct exec $CTID -- bash -lc 'test -e /root/.claude && tar czf /root/.claude.backup.\$(date +%s).tgz -C /root .claude 2>/dev/null || true'"
  if [[ "$CRED_MODE" == "token" ]]; then
    say "writing OAuth token to container env"
    printf 'export CLAUDE_CODE_OAUTH_TOKEN=%q\n' "$CLAUDE_CODE_OAUTH_TOKEN" \
      | remote_in "pct exec $CTID -- bash -c 'umask 077; cat >> /etc/profile.d/claude-loop.sh'"
  else
    say "copying Keychain credential to container (~/.claude/.credentials.json)"
    security find-generic-password -s "Claude Code-credentials" -w \
      | remote_in "pct exec $CTID -- bash -c 'umask 077; mkdir -p /root/.claude; cat > /root/.claude/.credentials.json'"
  fi
}

# ---- headless init + onboarding seed ---------------------------------------
finalize() {
  say "headless auth check + onboarding seed"
  remote "pct exec $CTID -- bash -lc '
    set -e
    timeout 90 claude -p \"say READY\" --permission-mode bypassPermissions >/dev/null 2>&1 || true
    node -e \"const fs=require(String.fromCharCode(102,115));const p=\\\"/root/.claude.json\\\";let d={};try{d=JSON.parse(fs.readFileSync(p))}catch(e){};d.hasCompletedOnboarding=true;d.theme=\\\"dark\\\";fs.writeFileSync(p,JSON.stringify(d,null,2))\"
  '"
}

smoke() {
  say "tmux smoke test (driving claude live)"
  local out
  out="$(remote "pct exec $CTID -- bash -lc claude-smoke")"
  printf '%s\n' "$out"
  printf '%s' "$out" | grep -q SMOKE_PASS || die "smoke test did not pass"
}

main() {
  resolve_credential_mode
  pick_ctid
  if [[ "$CONFIGURE_ONLY" == "1" ]]; then
    remote "pct status $CTID 2>/dev/null | grep -q running" || die "--configure-only needs CT $CTID already running"
    say "configure-only: leaving CT $CTID in place (no create/destroy)"
  else
    create_container
  fi
  bootstrap_container
  push_credential
  finalize
  smoke
  local ip
  ip="$(remote "pct exec $CTID -- ip -4 -br addr show eth0 | awk '{print \$3}'")"
  say "✅ DONE — container $CTID ($ip) runs claude via tmux"
  say "   attach:  ssh $PROXMOX -t 'pct exec $CTID -- bash -lc \"tmux -L clsmoke attach || bash\"'"
}

main
