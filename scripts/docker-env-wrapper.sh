#!/bin/sh
# Environment wrapper for Paperclip container diagnostics (OPE-1177 / OPE-3100)
# Masks credentials and sensitive secrets in environment variable output.
# When called with arguments to run a command (e.g. `env sh`, `env -i ...`, `env KEY=val ...`),
# transparently delegates to the real env binary without modifying arguments.

REAL_ENV="/usr/bin/env"
if [ ! -x "$REAL_ENV" ] || [ "$REAL_ENV" = "$0" ]; then
  if [ -x "/bin/env" ] && [ "/bin/env" != "$0" ]; then
    REAL_ENV="/bin/env"
  fi
fi

# If arguments are passed, transparently delegate to real env
if [ "$#" -gt 0 ]; then
  exec "$REAL_ENV" "$@"
fi

# No arguments: output masked environment
"$REAL_ENV" | sed -E \
  -e 's/^([^=]*_URL=[a-zA-Z0-9_+.-]+:\/\/[^:]*:)[^@]+(@.*)/\1***\2/' \
  -e 's/^([^=]*(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[^=]*=).*/\1***/I' \
  -e 's/(Password=)[^;]+(;)/\1***\2/g' \
  -e 's/(Password=)[^;]+$/\1***/g'
