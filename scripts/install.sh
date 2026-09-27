#!/usr/bin/env bash
# FlowSync 一行安装 / 升级脚本（Debian / Ubuntu 等使用 systemd 的 Linux，x86_64 或 arm64）
#   curl -fsSL https://github.com/hengyoungmiao/-notion-flow-/releases/latest/download/install.sh | bash
# 不要用 sudo 运行：程序装在当前用户目录，脚本只在注册系统服务时调用 sudo。
# 可选环境变量：
#   FLOWSYNC_VERSION=0.2.0     安装指定版本（默认最新）
#   FLOWSYNC_TARBALL=/path.tgz 使用本地发布包（离线安装、测试用）
#   FLOWSYNC_NO_SYSTEMD=1      不注册系统服务
set -euo pipefail

REPO="hengyoungmiao/-notion-flow-"
APP_DIR="${FLOWSYNC_APP_DIR:-$HOME/.flowsync/app}"
say() { printf '%s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "只支持 Linux"
if [ "$(id -u)" = "0" ] && [ -z "${FLOWSYNC_ALLOW_ROOT:-}" ]; then
  fail "请不要用 root / sudo 运行安装脚本，用平时登录的用户运行即可（需要时脚本会自己调用 sudo）"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "${FLOWSYNC_TARBALL:-}" ]; then
  cp "$FLOWSYNC_TARBALL" "$TMP/flowsync.tar.gz"
else
  command -v curl >/dev/null || fail "需要 curl：sudo apt-get install -y curl"
  if [ -n "${FLOWSYNC_VERSION:-}" ]; then
    URL="https://github.com/$REPO/releases/download/v${FLOWSYNC_VERSION#v}/flowsync-linux-$ARCH.tar.gz"
  else
    URL="https://github.com/$REPO/releases/latest/download/flowsync-linux-$ARCH.tar.gz"
  fi
  say "下载 $URL"
  curl -fL --retry 3 -o "$TMP/flowsync.tar.gz" "$URL" || fail "下载失败"
fi

tar -xzf "$TMP/flowsync.tar.gz" -C "$TMP"
[ -x "$TMP/flowsync/bin/flowsync" ] || fail "发布包内容不完整"
"$TMP/flowsync/node/bin/node" --version >/dev/null 2>&1 || fail "自带的 Node 无法在这台机器上运行"

# 替换旧版本（保留数据目录 ~/.flowsync 里的配置和同步记录）
mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$TMP/flowsync" "$APP_DIR"
rm -rf "$APP_DIR.old"
VERSION_INSTALLED="$("$APP_DIR/bin/flowsync" --version)"
say "✓ 已安装 FlowSync $VERSION_INSTALLED 到 $APP_DIR"

# 命令行入口
SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi
if [ -z "${FLOWSYNC_NO_SYSTEMD:-}" ] && { [ -z "$SUDO" ] || command -v sudo >/dev/null; }; then
  $SUDO ln -sf "$APP_DIR/bin/flowsync" /usr/local/bin/flowsync
  say "✓ 命令 flowsync 已可用"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$APP_DIR/bin/flowsync" "$HOME/.local/bin/flowsync"
  say "✓ 命令已链接到 $HOME/.local/bin/flowsync（请确认它在 PATH 里）"
fi

# 系统服务：开机自启、异常退出自动重启
if [ -z "${FLOWSYNC_NO_SYSTEMD:-}" ] && command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  UNIT="/etc/systemd/system/flowsync.service"
  $SUDO tee "$UNIT" >/dev/null <<UNIT_EOF
[Unit]
Description=FlowSync（滴答清单 → Notion FLO.W 同步）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
Environment=HOME=$HOME
WorkingDirectory=$HOME
ExecStart=$APP_DIR/bin/flowsync run
Restart=always
RestartSec=15
KillSignal=SIGTERM
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
UNIT_EOF
  $SUDO systemctl daemon-reload
  say "✓ 已注册系统服务 flowsync"
  if $SUDO systemctl is-active --quiet flowsync; then
    $SUDO systemctl restart flowsync
    say "✓ 后台服务已重启为新版本"
  fi
fi

say ""
if [ -f "$HOME/.flowsync/config.json" ] && grep -q '"onboarded": true' "$HOME/.flowsync/config.json"; then
  say "已经设置过了。启动（或确认）后台服务：sudo systemctl enable --now flowsync"
else
  say "下一步："
  say "  flowsync setup                          # 设置向导：登录滴答、登录 Notion、识别 FLO.W、首次同步"
  say "  sudo systemctl enable --now flowsync    # 设置完成后启动后台服务"
fi
say "  flowsync doctor                         # 检查环境和各个接口"
