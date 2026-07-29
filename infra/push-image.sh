#!/usr/bin/env bash
#
# Build the runner image and push it to the ECR repo the stack created. Run after any
# `cdk deploy`, and after any change to guest/yeet-run (the Dockerfile copies it in).
#
#   infra/push-image.sh
#
# Needs docker (with buildx for the arm64 cross-build) and aws credentials.
set -euo pipefail
cd "$(dirname "$0")"

REPO_URI=$(aws cloudformation describe-stacks --stack-name YeetCloud \
  --query "Stacks[0].Outputs[?OutputKey=='RunnerRepoUri'].OutputValue" --output text)
[ -n "$REPO_URI" ] && [ "$REPO_URI" != "None" ] \
  || { echo "push-image: no YeetCloud stack — deploy first (cd infra && npx cdk deploy)" >&2; exit 1; }

REGION=$(echo "$REPO_URI" | sed -E 's/.*\.([a-z0-9-]+)\.amazonaws\.com.*/\1/')

# The runner executes the SAME yeet-run the VM does; stage it fresh so the image can never
# drift from the repo.
cp ../guest/yeet-run runner/yeet-run

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${REPO_URI%%/*}"
docker buildx build --platform linux/arm64 -t "$REPO_URI:latest" --push runner/
echo "pushed $REPO_URI:latest"
