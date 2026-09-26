#!/usr/bin/env bash
# Set up nebula and Nebula Desktop in one go, on macOS.
#
#   ./scripts/setup.sh              # from a clone of this repo
#   curl -fsSL https://raw.githubusercontent.com/yobazy/nebula-desktop/main/scripts/setup.sh | bash
#
# 1. Checks the build tools (Xcode command line tools, Node 20+, Rust),
#    offering to install what's missing.
# 2. Installs nebula at the exact version this app is built against — the
#    daemon refuses clients from any other version — from the same release
#    files nebula's own installer uses.
# 3. Makes sure a login shell finds `nebula`: the app starts the daemon
#    through one.
# 4. Builds the app, puts it in /Applications, and opens it.
#
# Options:
#   --check        report what's installed and what would change; change nothing
#   --nebula-only  set up nebula, skip building the app
#   --no-open      don't open the app at the end
#   --yes          answer yes to every question (for unattended installs)
#
# Environment:
#   NEBULA_DESKTOP_DIR  where to clone the repo when run outside one
#                       (default: ~/nebula-desktop)
#   NEBULA_INSTALL_DIR  where the nebula binary goes (default: ~/.local/bin)
#   APP_DIR             where the app goes (default: /Applications)
set -euo pipefail

REPO_URL="https://github.com/yobazy/nebula-desktop"
NEBULA_REPO="AgentSystemLabs/nebula"
INSTALL_DIR="${NEBULA_INSTALL_DIR:-$HOME/.local/bin}"
APP_DIR="${APP_DIR:-/Applications}"
APP_NAME="Nebula Desktop.app"

CHECK=0 NEBULA_ONLY=0 OPEN=1 YES=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --nebula-only) NEBULA_ONLY=1 ;;
    --no-open) OPEN=0 ;;
    --yes | -y) YES=1 ;;
    -h | --help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' yellow=$'\033[33m' red=$'\033[31m' off=$'\033[0m'
[ -t 1 ] || { bold='' dim='' green='' yellow='' red='' off=''; }
step() { printf '\n%s==>%s %s%s%s\n' "$green" "$off" "$bold" "$*" "$off"; }
ok() { printf '  %s✓%s %s\n' "$green" "$off" "$*"; }
note() { printf '  %s!%s %s\n' "$yellow" "$off" "$*"; }
fail() { printf '\n%serror:%s %s\n' "$red" "$off" "$*" >&2; exit 1; }

# A yes/no question, read from the terminal even when this script arrives
# through a pipe (curl … | bash). Unattended with no terminal means no.
ask() {
  [ "$YES" = 1 ] && return 0
  { : </dev/tty; } 2>/dev/null || return 1
  printf '  %s?%s %s [y/N] ' "$yellow" "$off" "$1"
  read -r reply </dev/tty 2>/dev/null || return 1
  [[ "$reply" =~ ^[Yy] ]]
}

[ "$(uname -s)" = Darwin ] || fail "Nebula Desktop is a macOS app. On Linux, nebula's TUI works on its own: https://github.com/$NEBULA_REPO#install"

# ---- the repo ----

# Run from a clone, or from a pipe: then clone first and carry on from there.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/../src-tauri/Cargo.toml" ]; then
  ROOT="$(cd "$here/.." && pwd)"
else
  ROOT="${NEBULA_DESKTOP_DIR:-$HOME/nebula-desktop}"
  step "Getting the source"
  if [ -d "$ROOT/.git" ]; then
    ok "already cloned at $ROOT"
    [ "$CHECK" = 1 ] || git -C "$ROOT" pull --ff-only --quiet || note "couldn't update $ROOT; using it as it is"
  elif [ "$CHECK" = 1 ]; then
    note "would clone $REPO_URL to $ROOT"
    ROOT=""
  else
    git clone --quiet "$REPO_URL" "$ROOT"
    ok "cloned to $ROOT"
  fi
fi

# The nebula release this app is built against: the nebula-core tag pinned
# in src-tauri/Cargo.toml.
if [ -n "$ROOT" ]; then
  PIN=$(sed -n 's/^nebula-core = .*tag = "v\([^"]*\)".*/\1/p' "$ROOT/src-tauri/Cargo.toml")
else
  PIN=$(curl -fsSL "https://raw.githubusercontent.com/yobazy/nebula-desktop/main/src-tauri/Cargo.toml" |
    sed -n 's/^nebula-core = .*tag = "v\([^"]*\)".*/\1/p')
fi
[ -n "$PIN" ] || fail "couldn't read the pinned nebula version from src-tauri/Cargo.toml"

# ---- build tools ----

step "Checking build tools"

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode command line tools"
else
  note "the Xcode command line tools are missing (compilers the build needs)"
  if [ "$CHECK" = 0 ]; then
    xcode-select --install || true
    fail "finish the command line tools install in the window that opened, then run this again"
  fi
fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$NEBULA_ONLY" = 1 ]; then
  : # the app isn't being built, so Node and Rust don't matter
elif command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 20 ]; then
  ok "Node $(node --version)"
else
  note "Node 20 or newer is needed to build the app ($(command -v node >/dev/null && node --version || echo 'not installed'))"
  if [ "$CHECK" = 0 ]; then
    if command -v brew >/dev/null 2>&1 && ask "Install Node with Homebrew?"; then
      brew install node
    else
      fail "install Node 20+ (https://nodejs.org or 'brew install node'), then run this again"
    fi
  fi
fi

[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if [ "$NEBULA_ONLY" = 1 ]; then
  :
elif command -v cargo >/dev/null 2>&1; then
  ok "Rust $(cargo --version | cut -d' ' -f2)"
else
  note "Rust is needed to build the app"
  if [ "$CHECK" = 0 ]; then
    if ask "Install Rust with rustup (the official installer)?"; then
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
      . "$HOME/.cargo/env"
      ok "Rust $(cargo --version | cut -d' ' -f2)"
    else
      fail "install Rust from https://rustup.rs, then run this again"
    fi
  fi
fi

# ---- nebula ----

step "Setting up nebula $PIN"

installed_version() { "$1" --version 2>/dev/null | awk '{print $2}'; }
current=""
current_bin="$(command -v nebula || true)"
[ -z "$current_bin" ] && [ -x "$INSTALL_DIR/nebula" ] && current_bin="$INSTALL_DIR/nebula"
[ -n "$current_bin" ] && current="$(installed_version "$current_bin")"

install_nebula() {
  local arch target url tmp
  case "$(uname -m)" in
    arm64) target=aarch64-apple-darwin ;;
    x86_64) target=x86_64-apple-darwin ;;
    *) fail "no nebula build for $(uname -m)" ;;
  esac
  url="https://github.com/$NEBULA_REPO/releases/download/v$PIN/nebula-$target.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/nebula.tar.gz" || fail "couldn't download $url"
  tar -xzf "$tmp/nebula.tar.gz" -C "$tmp"
  mkdir -p "$INSTALL_DIR"
  install -m 755 "$tmp/nebula" "$INSTALL_DIR/nebula"
  rm -rf "$tmp"
  current_bin="$INSTALL_DIR/nebula"
  current="$(installed_version "$current_bin")"
  ok "installed nebula $current → $current_bin"
}

if [ "$current" = "$PIN" ]; then
  ok "nebula $current at $current_bin"
elif [ -z "$current" ]; then
  if [ "$CHECK" = 1 ]; then note "would install nebula $PIN to $INSTALL_DIR"; else install_nebula; fi
else
  # Another version is already here. The app only talks to $PIN, and nebula
  # upgrades by moving forward, so don't swap it out behind the user's back.
  note "nebula $current is installed, but this app is built for $PIN"
  if [ "$CHECK" = 0 ]; then
    newer=$(printf '%s\n%s\n' "$current" "$PIN" | sort -V | tail -1)
    if [ "$newer" = "$current" ]; then
      printf '    Your nebula is newer than this app. Update the app instead: pull the\n'
      printf '    latest nebula-desktop, or bump the nebula-core tag in src-tauri/Cargo.toml\n'
      printf '    to v%s and run this again.\n' "$current"
      ask "Or replace nebula $current with $PIN (older) for now?" || fail "nothing changed"
    else
      ask "Update nebula $current to $PIN?" || fail "nothing changed; the app will say it doesn't match your nebula"
    fi
    install_nebula
    if pgrep -f 'nebula daemon' >/dev/null 2>&1; then
      note "a nebula daemon from $current is still running. 'nebula kill' restarts it on $PIN,"
      note "but stops every session, so do it when your agents are idle."
    fi
  fi
fi

# The app starts the daemon through a login shell, so that shell must find
# nebula, not just this one.
if [ -n "$current_bin" ]; then
  bin_dir="$(dirname "$current_bin")"
  if "${SHELL:-/bin/zsh}" -lc 'command -v nebula' >/dev/null 2>&1; then
    ok "your login shell finds nebula"
  else
    case "$(basename "${SHELL:-zsh}")" in
      zsh) profile="$HOME/.zprofile" ;;
      bash) profile="$HOME/.bash_profile" ;;
      *) profile="$HOME/.profile" ;;
    esac
    line="export PATH=\"$bin_dir:\$PATH\""
    note "$bin_dir isn't on your login shell's PATH"
    if [ "$CHECK" = 0 ] && ask "Add it to $profile?"; then
      printf '\n# nebula\n%s\n' "$line" >>"$profile"
      ok "added to $profile"
    elif [ "$CHECK" = 0 ]; then
      note "add this to $profile yourself: $line"
    fi
  fi
fi

if command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || command -v cursor-agent >/dev/null 2>&1; then
  ok "an agent CLI is installed"
else
  note "no agent CLI found. nebula runs Claude Code, Codex, Cursor and others; for Claude Code:"
  note "  curl -fsSL https://claude.ai/install.sh | bash"
fi

[ "$NEBULA_ONLY" = 1 ] && { step "Done"; ok "nebula $PIN is ready. Run 'nebula' to start it."; exit 0; }

# ---- the app ----

step "Building Nebula Desktop"
if [ "$CHECK" = 1 ]; then
  note "would build the app and install it to $APP_DIR/$APP_NAME"
  exit 0
fi
cd "$ROOT"
npm ci --no-audit --no-fund --loglevel=error
printf '  %sthe first build compiles the Rust side and takes a few minutes%s\n' "$dim" "$off"
log="$(mktemp -t nebula-desktop-build)"
if ! npm run tauri build -- --bundles app >"$log" 2>&1; then
  tail -30 "$log" >&2
  fail "the build failed; the full log is at $log"
fi
built="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
[ -d "$built" ] || fail "the build didn't produce $built"
ok "built $APP_NAME"

target="$APP_DIR/$APP_NAME"
if [ -w "$APP_DIR" ] || { [ -e "$target" ] && [ -w "$target" ]; }; then
  rm -rf "$target"
  cp -R "$built" "$target"
  ok "installed to $target"
else
  note "can't write to $APP_DIR, so the app stays at $built"
  target="$built"
fi

step "Done"
ok "nebula $PIN and Nebula Desktop are set up"
printf '  The app connects to the nebula daemon, and offers to start it if it isn'"'"'t running.\n'
if [ "$OPEN" = 1 ]; then open "$target"; fi
