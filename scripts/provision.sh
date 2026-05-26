#!/usr/bin/env bash
#
# provision.sh — SSH to ANY Linux instance and unfold a headless Claude (claude + tmux).
#
# Usage:
#   ./provision.sh <user@host>                       # any ssh-reachable box (VPS, cloud, CT)
#   ./provision.sh --proxmox <root@pmx-host> <ctid>  # create a Debian LXC first, then provision it
#
# Flags: --recreate (proxmox only), --force-credential
# Credential: $CLAUDE_CODE_OAUTH_TOKEN if set, else the macOS Keychain.
#
# The box can be reached as root or as a sudo-capable user — package installs
# auto-prefix sudo when not root. Idempotent: re-running preserves a working login.

set -euo pipefail

PROXMOX_MODE=0; RECREATE=0; FORCE_CREDENTIAL=0; POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --proxmox) PROXMOX_MODE=1 ;;
    --recreate) RECREATE=1 ;;
    --force-credential) FORCE_CREDENTIAL=1 ;;
    --*) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
    *) POS+=("$1") ;;
  esac
  shift
done

say() { printf '\033[36m[provision]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[provision] error:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$PROXMOX_MODE" = 1 ]; then
  PMX_HOST="${POS[0]:?usage: provision.sh --proxmox <root@pmx-host> <ctid>}"
  CTID="${POS[1]:?usage: provision.sh --proxmox <root@pmx-host> <ctid>}"
else
  TARGET="${POS[0]:?usage: provision.sh <user@host>}"
fi

# ---- credential ----
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then CRED_MODE=token
elif command -v security >/dev/null 2>&1 && security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1; then CRED_MODE=keychain
else die "no credential — set CLAUDE_CODE_OAUTH_TOKEN or run from a Mac logged into Claude Code"; fi
say "credential: $CRED_MODE | transport: $([ "$PROXMOX_MODE" = 1 ] && echo "proxmox pct exec" || echo "direct ssh")"

ssh_pmx() { ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$PMX_HOST" "$@"; }

# Run a script (fed on stdin) on the box. Mode-aware; stdin is the only channel,
# so there is no remote-quoting to get wrong.
box_script() {
  if [ "$PROXMOX_MODE" = 1 ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$PMX_HOST" "pct exec $CTID -- bash -s"
  else
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$TARGET" "bash -s"
  fi
}

# ---- proxmox: create the container first ----
if [ "$PROXMOX_MODE" = 1 ]; then
  TEMPLATE="$(ssh_pmx "pveam list local | awk '/debian-13-standard/{print \$1; exit}'")"
  [ -n "$TEMPLATE" ] || die "no debian-13-standard template on $PMX_HOST"
  if ssh_pmx "pct status $CTID >/dev/null 2>&1"; then
    [ "$RECREATE" = 1 ] || die "CT $CTID already exists — --recreate to rebuild, or pick a fresh ctid"
    say "--recreate: destroying CT $CTID"
    ssh_pmx "pct stop $CTID >/dev/null 2>&1 || true; pct destroy $CTID --force --purge"
  fi
  say "creating + starting CT $CTID"
  ssh_pmx "pct create $CTID '$TEMPLATE' --hostname claude-runner-$CTID --cores 4 --memory 4096 --swap 512 --rootfs local-lvm:20 --net0 name=eth0,bridge=vmbr0,ip=dhcp --features nesting=1 --unprivileged 1 --ostype debian --onboot 0 >/dev/null; pct start $CTID"
  ssh_pmx "for i in \$(seq 1 30); do pct exec $CTID -- getent hosts deb.debian.org >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1" || die "CT network never came up"
fi

# ---- bootstrap: install toolchain + write the smoke script ----
say "installing toolchain (tmux, node 22, claude) — ~2 min"
box_script <<'BOOT'
set -e
SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq curl ca-certificates git tmux locales >/dev/null
$SUDO sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen 2>/dev/null || true
$SUDO locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
command -v claude >/dev/null 2>&1 || $SUDO npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
mkdir -p "$HOME/.claude"
grep -q IS_SANDBOX "$HOME/.profile" 2>/dev/null || echo 'export IS_SANDBOX=1' >> "$HOME/.profile"
cat > "$HOME/.claude-smoke" <<'SMOKE'
#!/usr/bin/env bash
set -euo pipefail
export IS_SANDBOX=1
# Seed onboarding flags right before launch — interactive claude otherwise hits the
# theme + login gates (and the login gate starts a fresh OAuth flow that ignores the
# credential file). Re-seeding here is idempotent and survives claude rewriting the file.
node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude.json";let d={};try{d=JSON.parse(fs.readFileSync(p))}catch(e){};d.hasCompletedOnboarding=true;d.theme="dark";fs.writeFileSync(p,JSON.stringify(d,null,2))' 2>/dev/null || true
SOCK=clsmoke; TOKEN="PROVISION_OK_$$"
EXTRA=""; [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && EXTRA="-e CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
tmux -L $SOCK kill-server 2>/dev/null || true
tmux -L $SOCK new-session -d -s t -x 220 -y 50 -e IS_SANDBOX=1 $EXTRA -c "$HOME" "claude --permission-mode bypassPermissions"
sent=0; pane=""
for _ in $(seq 1 45); do
  sleep 2
  pane="$(tmux -L $SOCK capture-pane -pt t -S -80 2>/dev/null || true)"
  if [ "$(printf '%s' "$pane" | grep -c "$TOKEN")" -ge 2 ]; then echo SMOKE_PASS; tmux -L $SOCK kill-server 2>/dev/null || true; exit 0; fi
  printf '%s' "$pane" | grep -q "I trust this folder" && { tmux -L $SOCK send-keys -t t Enter; continue; }
  printf '%s' "$pane" | grep -q "Yes, I accept" && { tmux -L $SOCK send-keys -t t Down; sleep 1; tmux -L $SOCK send-keys -t t Enter; continue; }
  if [ "$sent" -eq 0 ] && printf '%s' "$pane" | grep -q "shift+tab to cycle"; then
    tmux -L $SOCK send-keys -t t "Reply with exactly this token and nothing else: $TOKEN"; sleep 1; tmux -L $SOCK send-keys -t t Enter; sent=1; continue
  fi
done
echo SMOKE_FAIL; printf '%s\n' "$pane" | tail -25; tmux -L $SOCK kill-server 2>/dev/null || true; exit 1
SMOKE
chmod +x "$HOME/.claude-smoke"
echo bootstrap-done
BOOT

# ---- credential (preserve an existing working login) ----
ALREADY=0
if [ "$FORCE_CREDENTIAL" != 1 ]; then
  if box_script <<'CHK'
test -s "$HOME/.claude/.credentials.json" && IS_SANDBOX=1 timeout 60 claude -p ok --permission-mode bypassPermissions >/dev/null 2>&1
CHK
  then ALREADY=1; fi
fi

if [ "$ALREADY" = 1 ]; then
  say "box already has a WORKING claude login — preserving it (--force-credential to override)"
elif [ "$CRED_MODE" = token ]; then
  say "installing OAuth token into box profile"
  TOK_B64="$(printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" | base64)"
  TOK_B64="$TOK_B64" box_script <<EOF
grep -q CLAUDE_CODE_OAUTH_TOKEN "\$HOME/.profile" 2>/dev/null || \
  echo "export CLAUDE_CODE_OAUTH_TOKEN=\$(echo $TOK_B64 | base64 -d)" >> "\$HOME/.profile"
EOF
else
  say "copying Keychain credential to box (~/.claude/.credentials.json)"
  CRED_B64="$(security find-generic-password -s "Claude Code-credentials" -w | base64)"
  box_script <<EOF
umask 077; mkdir -p "\$HOME/.claude"
[ -e "\$HOME/.claude/.credentials.json" ] && cp "\$HOME/.claude/.credentials.json" "\$HOME/.claude/.credentials.json.bak.\$(date +%s)" || true
echo "$CRED_B64" | base64 -d > "\$HOME/.claude/.credentials.json"
chmod 600 "\$HOME/.claude/.credentials.json"
EOF
fi

# ---- finalize: headless init + onboarding seed ----
say "headless auth check + onboarding seed"
box_script <<'FIN'
set -e
. "$HOME/.profile" 2>/dev/null || true
export IS_SANDBOX=1
timeout 90 claude -p "say READY" --permission-mode bypassPermissions >/dev/null 2>&1 || true
node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude.json";let d={};try{d=JSON.parse(fs.readFileSync(p))}catch(e){};d.hasCompletedOnboarding=true;d.theme="dark";fs.writeFileSync(p,JSON.stringify(d,null,2))'
FIN

# ---- smoke: drive claude live via tmux ----
say "tmux smoke test (driving claude live)"
OUT="$(box_script <<'RUN'
. "$HOME/.profile" 2>/dev/null || true
bash "$HOME/.claude-smoke"
RUN
)"
printf '%s\n' "$OUT" | tail -2
printf '%s' "$OUT" | grep -q SMOKE_PASS || die "smoke test did not pass"
say "✅ DONE — box runs claude via tmux"
