#!/bin/sh
# Download one GGUF artifact and verify its SHA-256 against the pinned manifest before it is used.
#
#   verify-artifact.sh <manifest.json> <destination-dir>
#
# On success prints the verified local path (and nothing else) on stdout. Logs and failures go to
# stderr. Exit 1 means the worker must not start: a wrong hash is never repaired or retried with
# different bytes.
#
# The manifest is operator-supplied, not user content. Local URLs (file://, loopback http) are
# accepted only with ALLOW_LOCAL_ARTIFACT_URL=1 so a production manifest cannot be pointed at a
# local file by accident; a real pin is https:// plus a published SHA-256.
set -eu

die() {
    printf 'artifact verification: %s\n' "$*" >&2
    exit 1
}

[ "$#" -eq 2 ] || die "usage: verify-artifact.sh <manifest.json> <destination-dir>"
manifest=$1
dest=$2

[ -f "$manifest" ] || die "manifest not found: $manifest"
[ -r "$manifest" ] || die "manifest is not readable by uid $(id -u): $manifest"
for command in jq curl sha256sum; do
    command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

schema=$(jq -r '.schema // empty' "$manifest" 2>/dev/null) || die "cannot parse manifest: $manifest"
[ "$schema" = "openvibe.ai.worker-artifact@1" ] || die "manifest schema must be openvibe.ai.worker-artifact@1 (got '${schema:-missing}')"

field() {
    value=$(jq -r "$1" "$manifest" 2>/dev/null) || die "cannot read $2 from $manifest"
    case "$value" in
        ''|null) die "$2 is missing or empty in $manifest" ;;
    esac
    printf '%s' "$value"
}

model_id=$(field '.artifact.id' 'artifact.id')
revision=$(field '.artifact.revision' 'artifact.revision')
sha=$(field '.artifact.sha256' 'artifact.sha256')
url=$(field '.download.url' 'download.url')
filename=$(field '.download.filename' 'download.filename')

# A TODO is a promise the operator has not kept yet. Refuse it instead of downloading something
# that happens to be at a guessed URL, and never invent a hash.
case "$model_id $revision $sha $url $filename" in
    *TODO*) die "manifest still has a TODO placeholder; pin the revision and the published SHA-256 first" ;;
esac

case "$sha" in
    *[!0-9a-f]*) die "artifact.sha256 must be 64 lowercase hex characters" ;;
esac
[ "${#sha}" -eq 64 ] || die "artifact.sha256 must be 64 lowercase hex characters"

case "$filename" in
    ''|.|..|*/*) die "download.filename must be a plain file name" ;;
esac

case "$url" in
    https://*) ;;
    file://*|http://127.0.0.1:*|http://localhost:*)
        [ "${ALLOW_LOCAL_ARTIFACT_URL:-0}" = "1" ] || die "local artifact URLs require ALLOW_LOCAL_ARTIFACT_URL=1 (use https:// for a real pin)"
        ;;
    *) die "download.url must be https:// (local URLs only in a smoke test)" ;;
esac

mkdir -p "$dest" || die "cannot create $dest"
target="$dest/$filename"
part="$target.part.$$"

if [ -f "$target" ]; then
    actual=$(sha256sum "$target" | awk '{print $1}')
    if [ "$actual" = "$sha" ]; then
        printf '%s\n' "$target"
        exit 0
    fi
    printf 'artifact verification: existing %s does not match the manifest; downloading again\n' "$target" >&2
    rm -f "$target"
fi

rm -f "$part"
# --fail makes an HTTP error a non-zero exit; the file is never treated as an artifact.
if ! curl -fsSL --retry 3 --retry-connrefused --connect-timeout 20 -o "$part" "$url"; then
    rm -f "$part"
    die "download failed: $url"
fi

actual=$(sha256sum "$part" | awk '{print $1}')
if [ "$actual" != "$sha" ]; then
    rm -f "$part"
    die "SHA-256 mismatch for $filename: manifest $sha, downloaded $actual; refusing to start"
fi

mv "$part" "$target" || die "cannot move verified artifact into place: $target"
printf '%s\n' "$target"
