#!/usr/bin/env bash
# Compose one release's markdown body and write it to stdout.
#
# The body is CHANGELOG.md's section for <version> when that section exists and is
# non-empty; otherwise it falls back to GitHub's generated notes for the tag (which
# needs GH_TOKEN and a checkout that can resolve the previous tag). The standard
# install footer is appended either way, so both paths produce the same shape.
#
# Usage:
#   .github/scripts/compose-release-notes.sh <version> > notes.md
#
# Reads CHANGELOG.md from the working directory. Exactly the section headed
# "## [<version>]" is used: the heading must be followed by end of line or
# whitespace, so "## [0.4.0]" never matches "## [0.4.0-rc.1]".
set -euo pipefail

VERSION="${1:?usage: compose-release-notes.sh <version>}"
TAG="v${VERSION}"
TGZ="dsh-git-credentials-${VERSION}.tgz"

notes="$(awk -v want="## [${VERSION}]" '
  index($0, want) == 1 {
    rest = substr($0, length(want) + 1)
    if (rest == "" || rest ~ /^[[:space:]]/) { found = 1; next }
  }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md)"

if [ -z "${notes//[[:space:]]/}" ]; then
  echo "::warning::CHANGELOG.md has no section for ${VERSION}; using GitHub-generated notes" >&2
  prev="$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)"
  if [ -n "$prev" ]; then
    notes="$(gh api "repos/${GITHUB_REPOSITORY}/releases/generate-notes" \
      -f tag_name="$TAG" -f previous_tag_name="$prev" --jq .body)"
  else
    notes="$(gh api "repos/${GITHUB_REPOSITORY}/releases/generate-notes" \
      -f tag_name="$TAG" --jq .body)"
  fi
fi

printf '%s\n\n---\n\n' "$(printf '%s' "$notes" | sed '/[^[:space:]]/,$!d')"
printf '**Install:** download `%s` above and run `dsh plugin --profile <name> add ./%s`, then restart the GUI. ' "$TGZ" "$TGZ"
printf 'The same version installs as `dsh plugin --profile <name> add dsh-git-credentials` from npm once it is published there.\n'
