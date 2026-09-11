#!/usr/bin/env bash
# 把 AI 导入通道所需的 key / 配置写入雷达生产的 launchd plist。
#
# 用法：
#   ./scripts/set-import-keys.sh              # 预演（不写入，只打印将要做什么）
#   ./scripts/set-import-keys.sh --apply      # 真正写入
#   ./scripts/set-import-keys.sh --apply --reload   # 写入并重载雷达生产
#
# key 来源（全部从本机既有文件读取，不硬编码）：
#   COMMAND_CODE_API_KEY  ← ~/.commandcode/auth.json        的 apiKey
#   OPENCODE_GO_API_KEY   ← ~/.dsh/.credentials.yaml        的 OPENCODE_GO_API_KEY
#   DEEPSEEK_API_KEY      ← ~/.deepseek/config.toml         的 api_key
#
set -u

APPLY=0
RELOAD=0
for a in "$@"; do
  case "$a" in
    --apply)  APPLY=1 ;;
    --reload) RELOAD=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "未知参数: $a（可用：--apply --reload）" >&2; exit 2 ;;
  esac
done

PLIST="$HOME/Library/LaunchAgents/com.xinghao-radar.vite-dev.plist"
LABEL="com.xinghao-radar.vite-dev"

[ -f "$PLIST" ] || { echo "✗ plist 不存在: $PLIST" >&2; exit 1; }

# ---------- 读取 key ----------
read_cmdcode() {
  python3 - <<'PY' 2>/dev/null
import json, os
print(json.load(open(os.path.expanduser("~/.commandcode/auth.json")))["apiKey"], end="")
PY
}
read_yaml_key() { # $1 = key 名
  sed -nE "s/^$1:[[:space:]]*(.+)$/\1/p" "$HOME/.dsh/.credentials.yaml" 2>/dev/null | head -1
}
read_toml_key() { # $1 = key 名
  sed -nE "s/^$1[[:space:]]*=[[:space:]]*\"(.+)\".*/\1/p" "$HOME/.deepseek/config.toml" 2>/dev/null | head -1
}

COMMAND_CODE_API_KEY="$(read_cmdcode)"
OPENCODE_GO_API_KEY="$(read_yaml_key OPENCODE_GO_API_KEY)"
DEEPSEEK_API_KEY="$(read_toml_key api_key)"

mask() { [ -n "$1" ] && printf '%s***(%s字符)' "$(printf '%s' "$1" | cut -c1-8)" "${#1}" || printf '(空)'; }

echo "== 读取到的 key =="
printf '  %-24s %s\n' COMMAND_CODE_API_KEY "$(mask "$COMMAND_CODE_API_KEY")"
printf '  %-24s %s\n' OPENCODE_GO_API_KEY  "$(mask "$OPENCODE_GO_API_KEY")"
printf '  %-24s %s\n' DEEPSEEK_API_KEY     "$(mask "$DEEPSEEK_API_KEY")"
echo

for pair in "COMMAND_CODE_API_KEY:$COMMAND_CODE_API_KEY" \
            "OPENCODE_GO_API_KEY:$OPENCODE_GO_API_KEY" \
            "DEEPSEEK_API_KEY:$DEEPSEEK_API_KEY"; do
  [ -z "${pair#*:}" ] && { echo "✗ ${pair%%:*} 为空，请检查来源文件，已中止（未做任何修改）" >&2; exit 1; }
done

# ---------- 待写入的键值 ----------
KV_KEYS=(COMMAND_CODE_API_KEY IMPORT_MODEL_CMDCODE IMPORT_CHAIN OPENCODE_SESSION_ID)
KV_VALS=("$COMMAND_CODE_API_KEY" "deepseek/deepseek-v4.1-flash" "command-code,opencode-go,deepseek-api,openrouter" "radar-import-prod")
OPT_KEYS=(OPENCODE_GO_API_KEY DEEPSEEK_API_KEY)
OPT_VALS=("$OPENCODE_GO_API_KEY" "$DEEPSEEK_API_KEY")

echo "== 将要写入 $PLIST 的 EnvironmentVariables =="
for i in "${!KV_KEYS[@]}"; do printf '  %-24s = %s\n' "${KV_KEYS[$i]}" "$(case "${KV_KEYS[$i]}" in *_API_KEY) mask "${KV_VALS[$i]}" ;; *) printf '%s' "${KV_VALS[$i]}" ;; esac)"; done
for i in "${!OPT_KEYS[@]}"; do printf '  %-24s = %s\n' "${OPT_KEYS[$i]}" "$(mask "${OPT_VALS[$i]}")"; done
echo

if [ "$APPLY" -ne 1 ]; then
  echo "（预演模式，未写入。加 --apply 执行）"
  exit 0
fi

# ---------- 备份 ----------
BAK="$PLIST.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$PLIST" "$BAK" || { echo "✗ 备份失败，已中止" >&2; exit 1; }
echo "✓ 已备份 → $BAK"

# ---------- 写入（存在则 Set，不存在则 Add） ----------
set_kv() { # $1=key $2=value
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:$1 string $2" "$PLIST"
}

for i in "${!KV_KEYS[@]}"; do
  set_kv "${KV_KEYS[$i]}" "${KV_VALS[$i]}" || { echo "✗ 写入 ${KV_KEYS[$i]} 失败" >&2; exit 1; }
done
for i in "${!OPT_KEYS[@]}"; do
  set_kv "${OPT_KEYS[$i]}" "${OPT_VALS[$i]}" || { echo "✗ 写入 ${OPT_KEYS[$i]} 失败" >&2; exit 1; }
done
chmod 600 "$PLIST"
echo "✓ 写入完成"

# ---------- 校验 ----------
if ! plutil -lint "$PLIST" >/dev/null; then
  echo "✗ plist 语法校验失败！回滚中…" >&2
  cp -p "$BAK" "$PLIST"; echo "已回滚，请检查 $BAK" >&2; exit 1
fi
echo "✓ plist 语法校验通过"
echo "== 当前 EnvironmentVariables =="
plutil -p "$PLIST" | sed -n '/EnvironmentVariables/,/^  }/p' \
  | sed -E 's/(=> "((user_|sk-|gsk_)?[A-Za-z0-9_.-]{4})[^"]*)"/\1***"/g'

if [ "$RELOAD" -eq 1 ]; then
  launchctl unload "$PLIST" 2>/dev/null
  launchctl load  "$PLIST" 2>/dev/null
  sleep 2
  launchctl list | grep -q "$LABEL" && echo "✓ 已重载 $LABEL" || echo "⚠ 重载后未在 launchctl list 中看到 $LABEL，请检查日志"
  echo "  日志：~/Desktop/型号追踪/xinghao-radar-deploy/logs/production.{out,err}.log"
fi

cat <<'EOF'

生效条件（P1 代码已随 PR #22 落地）：
  defaultImportProvider() 会读 IMPORT_CHAIN 组装降级链，链上的直连通道见
  packages/import-engine/src/providers/chat-completions.ts。
  本脚本只负责「把 key 备好」；部署后仍走旧 OpenRouter 通道的唯一可能原因是
  生产还没部署到含该代码的 main（按规范 §4.3 部署）。
  校验是否生效：查生产日志，runs[].channel 应出现 command-code / deepseek-api 等通道名。

可调项：
  IMPORT_CHAIN_BUDGET_MS  整链总预算，默认 180000（ms）。超预算的通道记为 budget_exhausted。
EOF
