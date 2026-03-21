#!/usr/bin/env bash
# Ejecutar en Terminal de macOS (no desde Cursor si falla .git):
#   chmod +x scripts/push-github-ssh.sh && ./scripts/push-github-ssh.sh

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_SSH="git@github.com:Simonethg/aleph-hackathon-m2026.git"

if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO_SSH"
else
  git remote add origin "$REPO_SSH"
fi

git branch -M main
git push -u origin main

echo "Listo: https://github.com/Simonethg/aleph-hackathon-m2026"
