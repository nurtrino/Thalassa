#!/bin/sh
# Dev server for the screenshot harness / local play.
cd "$(dirname "$0")/.."
exec env TRIVIA_OFFLINE=1 DEV_CHEATS=1 BOT_TEMPO=0.3 QUESTION_SECS=3600 \
  python -m uvicorn server:app --port "${PORT:-5071}" --log-level warning
