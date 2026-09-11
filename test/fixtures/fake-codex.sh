#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "codex-cli test"
  exit 0
fi

if [[ "$1" == "exec" ]]; then
  printf '{"type":"thread.started","thread_id":"test-thread"}\n'
  if [[ " $* " == *" timeout-test "* ]]; then
    sleep 10
    exit 0
  fi
  sleep 0.15
  printf '{"type":"item.completed","item":{"text":"done"}}\n'
  exit 0
fi

printf 'fake codex ready\n'
while IFS= read -r line; do
  printf 'received:%s\n' "$line"
done
