#!/bin/sh

# Hash the deployed runtime payload while excluding separately verified
# provenance metadata. A temporary archive lets tar failures propagate under
# POSIX sh instead of being hidden by a pipeline.
runtime_artifact_sha256() (
	set -eu

	runtime_root=$1
	archive=$(mktemp "${TMPDIR:-/tmp}/subscription-routing-runtime.XXXXXX")
	trap 'rm -f "$archive"' 0 HUP INT TERM

	(
		CDPATH='' cd -- "$runtime_root"
		# The package deployment writes absolute destination paths into generated
		# launchers and records time/order state in .modules.yaml. Supported
		# entrypoints execute dist/cli.js directly, so omit that non-portable
		# installer metadata while hashing every runtime source and data file.
		tar \
			--sort=name \
			--format=posix \
			--mtime='UTC 1970-01-01' \
			--owner=0 \
			--group=0 \
			--numeric-owner \
			--hard-dereference \
			--pax-option=delete=atime,delete=ctime \
			--exclude='./CLODEX_REVISION' \
			--exclude='./SETUP_VERSIONS.env' \
			--exclude='./CLODEX_ARTIFACT_SHA256' \
			--exclude='*/.bin' \
			--exclude='*/.bin/*' \
			--exclude='*/.modules.yaml' \
			-cf "$archive" .
	)

	sha256sum "$archive" | cut -d ' ' -f1
)
