#!/usr/bin/env bash
# Сборка агента под все пять платформ в resources/agent/.
#
# CGO_ENABLED=0 не «на всякий случай», а требование: агент распространяется одним файлом,
# который кладётся на чужую машину по SSH, и внешних библиотек там может не быть никаких.
# Отсюда же ограничение — управление на macOS требует cgo и потому пока не сделано.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
out="../resources/agent"
mkdir -p "$out"

targets=(
  "linux amd64 argus-agent-linux-amd64"
  "linux arm64 argus-agent-linux-arm64"
  "windows amd64 argus-agent-windows-amd64.exe"
  "darwin amd64 argus-agent-darwin-amd64"
  "darwin arm64 argus-agent-darwin-arm64"
)

# -s -w выкидывают таблицу символов и отладочную информацию: по SSH едет на треть меньше.
flags=(-trimpath -ldflags "-s -w")

fail=0
for t in "${targets[@]}"; do
  read -r goos goarch name <<< "$t"
  printf '%-28s ' "$name"
  if CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build "${flags[@]}" -o "$out/$name" . 2>/tmp/argus-agent-build.err; then
    printf 'собран (%s)\n' "$(du -h "$out/$name" | cut -f1)"
  else
    printf 'ОШИБКА\n'
    sed 's/^/    /' /tmp/argus-agent-build.err
    fail=1
  fi
done

rm -f /tmp/argus-agent-build.err
exit "$fail"
