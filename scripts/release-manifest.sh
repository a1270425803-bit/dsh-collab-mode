#!/bin/sh
# release-manifest.sh — 从 git tree 生成/校验 release-manifest.sha256
#
# 用法：
#   sh scripts/release-manifest.sh            生成（覆盖）仓库根 release-manifest.sha256
#   sh scripts/release-manifest.sh --verify   只读校验：重算并与已提交 manifest 逐字节比对
#
# 契约（plan v5 §2.1）：
#   - 逐文件 SHA-256，覆盖全部 git 跟踪文件；manifest 排除自身
#   - 行格式与 shasum -a 256 一致：<64hex>  ./<path>，路径按 LC_ALL=C 排序
#   - manifest 由最终 git commit/tree hash 认证；任何文件变化必须重跑生成
#   - 仅依赖 git 与 shasum/sha256sum，无第三方依赖；非零退出即失败
set -eu

# 固定 locale，避免 shasum(perl) 本地化告警污染输出，保证排序与格式确定
LC_ALL=C
export LC_ALL

# 定位仓库根（脚本可从根目录或子目录调用）
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "release-manifest: not inside a git repository" >&2; exit 2;
}
cd "$ROOT"

MANIFEST="release-manifest.sha256"

# 选择 SHA-256 实现（macOS: shasum；Linux: sha256sum）
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
else
  echo "release-manifest: neither shasum nor sha256sum found" >&2; exit 2
fi

# 生成 manifest 内容到指定文件（排除 manifest 自身；NUL 分隔防特殊字符路径）
generate() {
  out=$1
  : > "$out"
  git ls-files -z | LC_ALL=C sort -z | while IFS= read -r -d '' f; do
    [ "$f" = "$MANIFEST" ] && continue
    [ -f "$f" ] || { echo "release-manifest: tracked file missing: $f" >&2; exit 3; }
    hash=$($SHA_CMD < "$f" | awk '{print $1}')
    printf '%s  ./%s\n' "$hash" "$f" >> "$out"
  done
}

case "${1:-}" in
  --verify)
    tmp_out=$(mktemp)
    trap 'rm -f "$tmp_out"' EXIT
    [ -f "$MANIFEST" ] || { echo "release-manifest: $MANIFEST not found" >&2; exit 4; }
    generate "$tmp_out"
    if cmp -s "$MANIFEST" "$tmp_out"; then
      echo "[OK] release-manifest: $(grep -c '' "$MANIFEST" | tr -d ' ') files verified against git tree"
      exit 0
    else
      echo "[FAIL] release-manifest mismatch (tracked tree vs $MANIFEST):" >&2
      diff "$MANIFEST" "$tmp_out" >&2 || true
      exit 1
    fi
    ;;
  ""|--generate)
    tmp_out=$(mktemp)
    trap 'rm -f "$tmp_out"' EXIT
    generate "$tmp_out"
    # 原子写入：临时文件 + rename
    mv "$tmp_out" "$MANIFEST"
    trap - EXIT
    echo "[OK] release-manifest: generated $MANIFEST ($(grep -c '' "$MANIFEST" | tr -d ' ') files)"
    ;;
  *)
    echo "usage: sh scripts/release-manifest.sh [--generate|--verify]" >&2
    exit 2
    ;;
esac
