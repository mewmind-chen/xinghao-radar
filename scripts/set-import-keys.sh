#!/usr/bin/env bash
# 把 AI 导入通道所需的 key / 配置写入雷达生产的 launchd plist。
#
# 用法：
#   ./scripts/set-import-keys.sh                    # 预演（不写入，只打印将要做什么）
#   ./scripts/set-import-keys.sh --apply            # 真正写入
#   ./scripts/set-import-keys.sh --apply --reload   # 写入并重载雷达生产（服务会中断数秒）
#   ./scripts/set-import-keys.sh --apply --chain=command-code,deepseek-api,openrouter
#                                                   # 显式指定链路（默认按 key 就位情况自动组装）
#
# 背景（为什么必须由人来跑这个脚本）：
#   生产进程读 env 的唯一来源是 launchd —— plist 的 EnvironmentVariables +
#   启动时继承的 GUI 域变量（launchctl setenv）。代码里的 available() 只认
#   process.env[apiKeyEnv]，不会去读 ~/.commandcode/auth.json 这类凭证文件；
#   而密钥被规范 §9 禁止入库 —— 所以「新通道生效」没有任何自动路径，
#   改代码、合并 PR、自动部署都不会让生产拿到 key。只能靠本脚本。
#
# key 来源（全部从本机既有文件读取，不硬编码任何值）：
#   COMMAND_CODE_API_KEY  ← ~/.commandcode/auth.json  的 apiKey
#   DEEPSEEK_API_KEY      ← ~/.deepseek/config.toml   的 api_key
#   OPENCODE_GO_API_KEY   ← ~/.dsh/.credentials.yaml  的 OPENCODE_GO_API_KEY，
#                            回退 ~/.local/share/opencode/auth.json 的 opencode-go.key
#
# 自动组装链路时，只纳入「key 就位」的通道；显式 --chain 里若有通道缺 key 则中止，
# 以免把空值写进 plist —— 那会让该通道被静默跳过（正是本项目反复踩过的坑）。
#
set -u
umask 077

usage() {
  cat <<'USAGE'
用法：
  ./scripts/set-import-keys.sh                   预演（不写入，只打印将要做什么）
  ./scripts/set-import-keys.sh --apply           真正写入 plist
  ./scripts/set-import-keys.sh --apply --reload  写入并重载雷达生产（服务会中断数秒）
  ./scripts/set-import-keys.sh --chain=<a,b,c>   显式指定 IMPORT_CHAIN（默认自动组装）
USAGE
}

APPLY=0
RELOAD=0
CHAIN_OVERRIDE=""
for a in "$@"; do
  case "$a" in
    --apply)   APPLY=1 ;;
    --reload)  RELOAD=1 ;;
    --chain=*) CHAIN_OVERRIDE="${a#--chain=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $a" >&2; usage >&2; exit 2 ;;
  esac
done

CONFIG_ROOT="${RADAR_CONFIG_HOME:-$HOME}"
PLIST="$CONFIG_ROOT/Library/LaunchAgents/com.xinghao-radar.vite-dev.plist"
LABEL="com.xinghao-radar.vite-dev"

[ -f "$PLIST" ] || { echo "✗ plist 不存在: $PLIST" >&2; exit 1; }

# ---------- 读取 key ----------
read_cmdcode() {
  node -e 'try { const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).apiKey; if(typeof v==="string") process.stdout.write(v.trim()); } catch {}' "$CONFIG_ROOT/.commandcode/auth.json"
}
read_dsh_key() { # $1 = 顶层键名
  sed -nE "s/^$1:[[:space:]]*(.+)$/\1/p" "$CONFIG_ROOT/.dsh/.credentials.yaml" 2>/dev/null | head -1
}
read_toml_key() { # $1 = 键名
  sed -nE "s/^$1[[:space:]]*=[[:space:]]*\"(.+)\".*/\1/p" "$CONFIG_ROOT/.deepseek/config.toml" 2>/dev/null | head -1
}
read_opencode_key() {
  node -e 'try { const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))["opencode-go"].key; if(typeof v==="string") process.stdout.write(v.trim()); } catch {}' "$CONFIG_ROOT/.local/share/opencode/auth.json"
}

COMMAND_CODE_API_KEY="$(read_cmdcode)"
DEEPSEEK_API_KEY="$(read_toml_key api_key)"

OPENCODE_GO_API_KEY=""
OPENCODE_GO_SOURCE="未读取（不在显式链路内）"
if [ -z "$CHAIN_OVERRIDE" ] || [[ ",${CHAIN_OVERRIDE// /}," == *,opencode-go,* ]]; then
  OPENCODE_GO_API_KEY="$(read_dsh_key OPENCODE_GO_API_KEY)"
  OPENCODE_GO_SOURCE="~/.dsh/.credentials.yaml"
  if [ -z "$OPENCODE_GO_API_KEY" ]; then
    OPENCODE_GO_API_KEY="$(read_opencode_key)"
    OPENCODE_GO_SOURCE="~/.local/share/opencode/auth.json"
  fi
fi

mask() { [ -n "$1" ] && printf '[已配置]' || printf '[未配置]'; }

echo "== 读取到的 key =="
printf '  %-24s %s\n' COMMAND_CODE_API_KEY "$(mask "$COMMAND_CODE_API_KEY")"
printf '  %-24s %s\n' DEEPSEEK_API_KEY     "$(mask "$DEEPSEEK_API_KEY")"
if [ -n "$OPENCODE_GO_API_KEY" ]; then
  printf '  %-24s %s  ← %s\n' OPENCODE_GO_API_KEY "$(mask "$OPENCODE_GO_API_KEY")" "$OPENCODE_GO_SOURCE"
else
  printf '  %-24s %s  ← %s\n' OPENCODE_GO_API_KEY "$(mask "")" "$OPENCODE_GO_SOURCE"
fi
echo

# ---------- 组装 IMPORT_CHAIN ----------
ALL_CHANNELS=(command-code opencode-go deepseek-api openrouter)

if [ -n "$CHAIN_OVERRIDE" ]; then
  IFS=',' read -r -a CHAIN_CHANNELS <<<"$CHAIN_OVERRIDE"
  for i in "${!CHAIN_CHANNELS[@]}"; do CHAIN_CHANNELS[$i]="${CHAIN_CHANNELS[$i]// /}"; done
else
  # 自动：按设计顺序，只纳入 key 就位的直连通道；openrouter 是观察位，固定垫底。
  CHAIN_CHANNELS=()
  [ -n "$COMMAND_CODE_API_KEY" ] && CHAIN_CHANNELS+=(command-code)
  [ -n "$OPENCODE_GO_API_KEY" ] && CHAIN_CHANNELS+=(opencode-go)
  [ -n "$DEEPSEEK_API_KEY" ] && CHAIN_CHANNELS+=(deepseek-api)
  CHAIN_CHANNELS+=(openrouter)
fi
[ "${#CHAIN_CHANNELS[@]}" -eq 0 ] && { echo "✗ 链路为空" >&2; exit 1; }

for name in "${CHAIN_CHANNELS[@]}"; do
  case "$name" in
    command-code|opencode-go|deepseek-api|openrouter) ;;
    *) echo "✗ 未知通道 \"$name\"（可用：${ALL_CHANNELS[*]}）" >&2; exit 1 ;;
  esac
done
# 链路里列了却拿不到 key 的通道 —— 中止，避免写出空值造成静默跳过。
for name in "${CHAIN_CHANNELS[@]}"; do
  case "$name" in
    command-code) [ -z "$COMMAND_CODE_API_KEY" ] && { echo "✗ 链路含 command-code 但 key 为空（来源 ~/.commandcode/auth.json）" >&2; exit 1; } ;;
    opencode-go)  [ -z "$OPENCODE_GO_API_KEY" ]  && { echo "✗ 链路含 opencode-go 但 key 为空（来源 ~/.dsh/.credentials.yaml / ~/.local/share/opencode/auth.json）" >&2; exit 1; } ;;
    deepseek-api) [ -z "$DEEPSEEK_API_KEY" ]     && { echo "✗ 链路含 deepseek-api 但 key 为空（来源 ~/.deepseek/config.toml）" >&2; exit 1; } ;;
  esac
done

IMPORT_CHAIN="$(IFS=,; printf '%s' "${CHAIN_CHANNELS[*]}")"
in_chain() { local n; for n in "${CHAIN_CHANNELS[@]}"; do [ "$n" = "$1" ] && return 0; done; return 1; }

# ---------- 待写入的键值 ----------
KV_KEYS=(); KV_VALS=()
add_kv() { KV_KEYS+=("$1"); KV_VALS+=("$2"); }

if in_chain command-code; then
  add_kv COMMAND_CODE_API_KEY "$COMMAND_CODE_API_KEY"
  add_kv IMPORT_MODEL_CMDCODE "deepseek/deepseek-v4.1-flash"
fi
if in_chain opencode-go; then
  add_kv OPENCODE_GO_API_KEY      "$OPENCODE_GO_API_KEY"
  add_kv IMPORT_MODEL_OPENCODE_GO "deepseek-v4-flash"
  add_kv OPENCODE_SESSION_ID      "radar-import-prod"
fi
if in_chain deepseek-api; then
  add_kv DEEPSEEK_API_KEY      "$DEEPSEEK_API_KEY"
  add_kv IMPORT_MODEL_DEEPSEEK "deepseek-flash"
fi
add_kv IMPORT_CHAIN           "$IMPORT_CHAIN"
add_kv IMPORT_CHAIN_BUDGET_MS "180000"

echo "== 将要写入 $PLIST 的 EnvironmentVariables =="
for i in "${!KV_KEYS[@]}"; do
  k="${KV_KEYS[$i]}"; v="${KV_VALS[$i]}"
  case "$k" in
    *_API_KEY) printf '  %-28s = %s\n' "$k" "$(mask "$v")" ;;
    *)         printf '  %-28s = %s\n' "$k" "$v" ;;
  esac
done
echo
echo "== 降级链 =="
echo "  $IMPORT_CHAIN"
if ! in_chain opencode-go; then
  echo "  opencode-go 未纳入：显式链路排除或本机缺少凭据。"
fi
echo "  凭据就位不代表上游可用；额度、权限和网络需另行实测。"
echo

if [ "$APPLY" -ne 1 ]; then
  echo "（预演模式，未写入。加 --apply 执行）"
  exit 0
fi

# ---------- 备份 ----------
BAK="$PLIST.bak-$(date +%Y%m%d-%H%M%S)-$$"
cp -p "$PLIST" "$BAK" || { echo "✗ 备份失败，已中止" >&2; exit 1; }
chmod 600 "$BAK" || exit 1
echo "✓ 已备份 → $BAK"
rollback() {
  echo "✗ 配置失败，恢复备份" >&2
  cp -p "$BAK" "$PLIST" || { echo "✗ 恢复配置失败，请检查备份" >&2; exit 1; }
  if [ "$RELOAD" -eq 1 ]; then
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST" >/dev/null 2>&1 || true
  fi
  exit 1
}

# ---------- 写入（存在则 Set，不存在则 Add） ----------
set_kv() { # $1=key $2=value
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:$1 $2" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:$1 string $2" "$PLIST" >/dev/null 2>&1
}

for i in "${!KV_KEYS[@]}"; do
  set_kv "${KV_KEYS[$i]}" "${KV_VALS[$i]}" || rollback
done
chmod 600 "$PLIST" || rollback
echo "✓ 写入完成"

# ---------- 校验 ----------
if ! plutil -lint "$PLIST" >/dev/null; then
  echo "✗ plist 语法校验失败！回滚中…" >&2
  rollback
fi
echo "✓ plist 语法校验通过"
echo "✓ 仅显示上方配置摘要，不输出环境变量原文"

if [ "$RELOAD" -eq 1 ]; then
  launchctl unload "$PLIST" >/dev/null 2>&1 || rollback
  launchctl load  "$PLIST" >/dev/null 2>&1 || rollback
  HEALTHY=0
  for attempt in {1..30}; do
    if curl -fsS --max-time 2 http://127.0.0.1:8082/healthz 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'; then
      HEALTHY=1; break
    fi
    sleep 1
  done
  [ "$HEALTHY" -eq 1 ] || rollback
  echo "✓ 已重载 ${LABEL}，健康检查通过"
  echo "  日志：~/Desktop/型号追踪/xinghao-radar-deploy/logs/production.{out,err}.log"
fi

cat <<'EOF'

生效条件与校验：
  代码侧 defaultImportProvider() 按 IMPORT_CHAIN 组装降级链（见
  packages/import-engine/src/providers/chat-completions.ts）。env 是进程启动时读入的，
  所以改完必须 --reload，否则跑着的进程仍用旧环境。
  校验：curl -s http://127.0.0.1:8082/healthz 看 importChannels（各通道 key 是否就位）；
        导入一次后查 runs[].channel / 预览标题里的通道名。

可调项：
  IMPORT_CHAIN           通道顺序，逗号分隔；换主备顺序只改这一个字符串。
  IMPORT_CHAIN_BUDGET_MS 整链总预算（ms），默认 180000；超预算的通道记为 budget_exhausted。

注意：
  本脚本不碰 OPENROUTER_API_KEY —— 那把目前只活在 launchd GUI 域（plist 里没有），
  launchctl setenv 的值重启即丢。若哪天 openrouter 通道突然不可用，先查这一项。
EOF
