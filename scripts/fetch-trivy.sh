#!/usr/bin/env bash
# [SEC-AUDIT 13 Nov 2026 · F6] ONE pinned, checksum-verified Trivy for the
# dependency scan, fetched the way scripts/fetch-gitleaks.sh fetches gitleaks.
#
# The old step piped the release tarball straight into tar and ran it. A
# tampered or replaced release asset would have run as the scanner that decides
# whether a HIGH/CRITICAL dependency blocks the build (and could fake a clean
# scan). The version and the SHA-256 below are pinned together (the hash is the
# release's own trivy_<v>_checksums.txt entry, checked against the downloaded
# asset when pinned); bumping one without the other fails loudly instead of
# silently trusting whatever the URL serves that day.
#
#   bash scripts/fetch-trivy.sh            → ./trivy (linux x64)
set -euo pipefail

VERSION="0.72.0"
SHA256="bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"
TARBALL="trivy_${VERSION}_Linux-64bit.tar.gz"
URL="https://github.com/aquasecurity/trivy/releases/download/v${VERSION}/${TARBALL}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

curl -sSfL -o "${TMP}/${TARBALL}" "${URL}"
if ! echo "${SHA256}  ${TMP}/${TARBALL}" | sha256sum -c - >/dev/null 2>&1; then
  echo "::error::trivy ${VERSION} tarball checksum mismatch — refusing to run an unverified scanner"
  echo "  expected ${SHA256}"
  echo "  got      $(sha256sum "${TMP}/${TARBALL}" | cut -d' ' -f1)"
  rm -rf "${TMP}"
  exit 1
fi
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}" trivy
mv "${TMP}/trivy" ./trivy
rm -rf "${TMP}"
./trivy --version
