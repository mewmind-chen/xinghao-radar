#!/usr/bin/env bash
# 导入通道双跑观察：同一批样本分别走 dsh headless(CLI) 与 OpenCode Go(直连)，记录指标。
#
# 用法:
#   RUNS=3 ./scripts/import-dual-run.sh
#
# 输出:
#   logs/import-dual-run.csv   每行一次调用的指标（追加写入）
#
# 指标口径（对应优化计划 §3 五项判据）:
#   latency_s  延迟          → 「延迟」判据
#   json_ok    输出是否合法 JSON → 「确定性」代理指标
#   rows       解析出的行数    → 输出合规率
#   exit       进程/HTTP 是否正常 → 「稳定性」代理指标
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RUNS="${RUNS:-1}"
OUT_CSV="${OUT_CSV:-logs/import-dual-run.csv}"
CALL_TIMEOUT="${CALL_TIMEOUT:-90}"   # 单次调用硬超时（秒）——dsh 实测会卡到 200s+，必须兜住
CHANNELS="${CHANNELS:-dsh go}"       # 只跑指定通道，例如 CHANNELS=dsh
MODEL_GO="${MODEL_GO:-deepseek-v4-flash}"
MODEL_CLI="${MODEL_CLI:-deepseek-flash}"
TEMPLATE="${TEMPLATE:-tools/import-lab/prompt-v2.template.txt}"
FIXTURE_DIR="${FIXTURE_DIR:-tests/radar-agent-import-recovery}"
KIND_HINT="${KIND_HINT:-mixed}"

KEY_GO="${OPENCODE_GO_API_KEY:-$(grep '^OPENCODE_GO_API_KEY:' "$HOME/.dsh/.credentials.yaml" 2>/dev/null | sed 's/^OPENCODE_GO_API_KEY: //')}"
KEY_DS="${DEEPSEEK_API_KEY:-$(grep '^DEEPSEEK_API_KEY:' "$HOME/.dsh/.credentials.yaml" 2>/dev/null | sed 's/^DEEPSEEK_API_KEY: //')}"

[ -f "$TEMPLATE" ] || { echo "缺少模板: $TEMPLATE"; exit 1; }
[ -n "$KEY_GO" ] || { echo "缺少 OpenCode Go key"; exit 1; }

mkdir -p "$(dirname "$OUT_CSV")"
[ -f "$OUT_CSV" ] || echo "ts,sample,mode,channel,latency_s,exit,json_ok,rows,raw_len,note" > "$OUT_CSV"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ROWS_SAMPLE='老板你好，我是华强北的供货商小李，我这边现货有下面这些，价格都可以谈：
1、STM32F103C8T6 5000片 22+ 含税3.2元/片，深圳仓现货
2、LM2596S-ADJ 2000片 24+ 1.85 含税，现货
另外客户问 TPS5430DDAR 500片，目标价2.5'

build_prompt() { # $1=out_file $2=sample_text
  {
    cat "$TEMPLATE"
    printf '\n业务类型提示: %s\n来源类型: text\n来源文本:\n%s\n' "$KIND_HINT" "$2"
  } > "$1"
}

# 从响应体中取出模型正文（兼容 OpenRouter / OpenAI 兼容格式）
extract_content() {
  python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(d,dict):
    if "choices" in d:
        print(d["choices"][0].get("message",{}).get("content") or "")
    elif "error" in d:
        print("ERROR:"+json.dumps(d["error"],ensure_ascii=False)[:160], file=sys.stderr)
'
}

call_go() { # $1=prompt_file
  python3 -c '
import json,sys
p=open(sys.argv[1]).read()
print(json.dumps({"model":sys.argv[2],"messages":[{"role":"user","content":p}],
                  "temperature":0,"max_tokens":16000}))
' "$1" "$MODEL_GO" > "$WORK/go-payload.json"

  curl -s -m "$CALL_TIMEOUT" -X POST https://opencode.ai/zen/go/v1/chat/completions \
    -H "Authorization: Bearer $KEY_GO" \
    -H "Content-Type: application/json" \
    -H "x-opencode-session: ses_dualrun_$$" \
    -d @"$WORK/go-payload.json"
}

call_dsh() { # $1=prompt_file
  # dsh 无内建超时，用 perl alarm 硬兜；否则单次可卡 200s+
  perl -e 'alarm shift; exec @ARGV' "$CALL_TIMEOUT" \
    env DEEPSEEK_API_KEY="$KEY_DS" DEEPSEEK_MODEL="$MODEL_CLI" \
    dsh --profile headless "$(cat "$1")" 2>/dev/null
}

# 输出 "<exit> <json_ok> <rows> <raw_len>"
measure() { # $1=raw_file $2=exit_code
  python3 -c '
import json,sys
raw=open(sys.argv[1],encoding="utf-8",errors="replace").read()
s=raw.find("{"); e=raw.rfind("}")
ok=0; rows=0
if s>=0 and e>s:
    try:
        d=json.loads(raw[s:e+1]); ok=1
        if isinstance(d.get("rows"),list): rows=len(d["rows"])
    except Exception:
        ok=0
print(f"{sys.argv[2]} {ok} {rows} {len(raw)}")
' "$1" "$2"
}

now() { python3 -c 'import time;print(f"{time.time():.2f}")'; }

declare -a SAMPLES MODES TEXTS
add() { SAMPLES+=("$1"); MODES+=("$2"); TEXTS+=("$3"); }

add "rows-mixed" "rows" "$ROWS_SAMPLE"
[ -f "$FIXTURE_DIR/unknown-cn.csv" ] && add "map-cn" "mapping" "$(cat "$FIXTURE_DIR/unknown-cn.csv")"
[ -f "$FIXTURE_DIR/unknown-en.csv" ] && add "map-en" "mapping" "$(cat "$FIXTURE_DIR/unknown-en.csv")"

echo "样本 ${#SAMPLES[@]} 个 × 通道 2 个 × 重复 ${RUNS} 次 = $(( ${#SAMPLES[@]} * 2 * RUNS )) 次调用"
echo

for i in "${!SAMPLES[@]}"; do
  name="${SAMPLES[$i]}"; mode="${MODES[$i]}"; text="${TEXTS[$i]}"
  build_prompt "$WORK/prompt.txt" "$text"

  for r in $(seq 1 "$RUNS"); do
    for ch in $CHANNELS; do
      t0="$(now)"
      if [ "$ch" = dsh ]; then
        call_dsh "$WORK/prompt.txt" > "$WORK/raw.txt" 2>"$WORK/err.txt"; code=$?
      else
        call_go "$WORK/prompt.txt" > "$WORK/resp.json" 2>"$WORK/err.txt"; code=$?
        extract_content < "$WORK/resp.json" > "$WORK/raw.txt" 2>>"$WORK/err.txt"
      fi
      t1="$(now)"
      lat="$(python3 -c "print(f'{$t1-$t0:.2f}')")"
      read -r ec jok rows rlen <<<"$(measure "$WORK/raw.txt" "$code")"
      note="$(head -c 60 "$WORK/err.txt" 2>/dev/null | tr '\n' ' ' | tr -d ',')"
      if [ "$code" -ge 124 ] && [ -z "$note" ]; then note="timeout>${CALL_TIMEOUT}s"; fi
      [ -z "$note" ] && [ "$jok" = 0 ] && note="no-json"
      printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$(date '+%Y-%m-%dT%H:%M:%S')" "$name" "$mode" "$ch" "$lat" "$ec" "$jok" "$rows" "$rlen" "$note" >> "$OUT_CSV"
      printf '  %-10s %-4s run%s  延迟 %6ss  合法=%s  行数=%s  %s\n' "$name" "$ch" "$r" "$lat" "$jok" "$rows" "$note"
    done
  done
done

echo
echo "=== 汇总（$OUT_CSV）==="
python3 - "$OUT_CSV" <<'PY'
import csv, sys, collections
rows=[r for r in csv.DictReader(open(sys.argv[1]))]
if not rows: sys.exit(0)
agg=collections.defaultdict(lambda: {"n":0,"ok":0,"rows":0,"lat":0.0,"fail":0})
for r in rows:
    k=(r["channel"], r["mode"] if r["mode"]=="mapping" else "rows")
    a=agg[k]; a["n"]+=1
    a["ok"]+= int(r["json_ok"]); a["rows"]+= int(r["rows"])
    a["lat"]+= float(r["latency_s"]); a["fail"]+= (int(r["exit"])!=0)
print(f"{'通道':<6}{'模式':<9}{'次数':>4}{'JSON合法率':>11}{'平均行数':>9}{'平均延迟':>10}{'进程失败':>9}")
for (ch,mode),a in sorted(agg.items()):
    print(f"{ch:<6}{mode:<9}{a['n']:>4}{a['ok']/a['n']*100:>10.0f}%{a['rows']/a['n']:>9.1f}{a['lat']/a['n']:>9.1f}s{a['fail']:>9}")
PY
