#!/bin/bash
# SessionStart hook: make remote (web) Claude Code sessions commit as Jesse.
# Web containers ship a global git identity of "Claude <noreply@anthropic.com>"
# and the repo is cloned fresh each session, so the repo-local override has to
# be reapplied every time. Local sessions already commit as nuvig — skip them.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

git -C "${CLAUDE_PROJECT_DIR:-.}" config user.name "nuvig"
git -C "${CLAUDE_PROJECT_DIR:-.}" config user.email "atjessel@gmail.com"
