#!/bin/bash

# Load the cache directory and TTL
CACHE_DIR="$HOME/.cache/zsh"
TTL=14400 # 24 hours in seconds

# Find and delete files older than the TTL
find "$CACHE_DIR" -type f -mmin +$((TTL/60)) -exec rm {} \;
