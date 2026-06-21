#!/usr/bin/env bash
# Start the CoMER handwriting recognition API server.
# Run this from the server/ directory.
# The server will listen on http://0.0.0.0:8000

set -e

cd "$(dirname "$0")"

# Activate virtual environment if it exists:
# - If .venv is in the whiteboard_2 root (../.venv) use that
# - Otherwise check local .venv
if [ -d "../.venv" ]; then
    echo "Activating virtual environment (../.venv)..."
    source ../.venv/bin/activate
elif [ -d ".venv" ]; then
    echo "Activating virtual environment..."
    source .venv/bin/activate
fi

echo "Starting CoMER HWR API server on http://0.0.0.0:8000 ..."
echo "To start: cd server && bash start_server.sh"
python server.py