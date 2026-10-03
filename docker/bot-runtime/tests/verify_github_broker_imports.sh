#!/bin/bash
# Script to verify the GitHub broker imports work correctly in the Docker build
# This should be integrated into the Dockerfile for build-time validation

echo "Running build-time verification of GitHub broker imports..."

# Add the hermes source to Python path
export PYTHONPATH="/opt/hermes-src:$PYTHONPATH"

# Run the verification test
cd /opt/hermes-src && python docker/bot-runtime/tests/build_time_verification.py

if [ $? -eq 0 ]; then
    echo "✓ Build-time verification passed!"
    exit 0
else
    echo "✗ Build-time verification failed!"
    exit 1
fi