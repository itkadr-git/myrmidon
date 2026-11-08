set -eu
cd "$1"
for d in data/hermes workspace scratch; do
  chmod 0700 "$d"
  chown 10001:10001 "$d"
done
chmod 0711 bot
if test -d package-cache; then
  install -d -o 10001 -g 10001 "package-cache/pnpm"
  install -d -o 10001 -g 10001 "package-cache/pnpm-store"
  install -d -o 10001 -g 10001 "package-cache/uv"
  install -d -o 10001 -g 10001 "package-cache/go-mod"
  install -d -o 10001 -g 10001 "package-cache/go-build"
  install -d -o 10001 -g 10001 "package-cache/gradle"
fi