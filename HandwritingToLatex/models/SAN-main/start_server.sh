#!/usr/bin/env bash
# Start the SAN LaTeX recognition server.
# Usage: cd HandwritingToLatex/models/SAN-main && bash start_server.sh
# The server will listen on http://0.0.0.0:8001

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Working directory: $(pwd)"

# Activate virtual environment if it exists
VENV_DIR="../.venv"
if [ -d "$VENV_DIR" ]; then
    echo "Activating virtual environment ($VENV_DIR)..."
    source "$VENV_DIR/bin/activate"
    echo "Using Python: $(which python3)"
elif [ -d ".venv" ]; then
    echo "Activating virtual environment (local .venv)..."
    source ".venv/bin/activate"
    echo "Using Python: $(which python3)"
else
    echo "WARNING: No virtual environment found at $VENV_DIR"
    echo "Falling back to system python3 (may not have torch installed)"
fi

echo "Starting SAN HWR API server on http://0.0.0.0:8001 ..."
python3 -m uvicorn server:app --host 0.0.0.0 --port 8001 --reload