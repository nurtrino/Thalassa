#!/bin/sh
# The Thalassa QA gate. Usage: tools/qa/run_qa.sh [outdir] [suite ...]
cd "$(dirname "$0")/../.."
PY=".venv/bin/python"; [ -x "$PY" ] || PY="python3"
exec "$PY" tools/qa/run_qa.py "${@:-qa_report/latest}"
