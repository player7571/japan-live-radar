#!/usr/bin/env bash
set -u

echo "GITHUB_ACTIONS: ${GITHUB_ACTIONS:-}"
echo "VERCEL_ENV: ${VERCEL_ENV:-}"
echo "VERCEL_GIT_COMMIT_REF: ${VERCEL_GIT_COMMIT_REF:-}"

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "Build can proceed in GitHub Actions."
  exit 1
fi

if [ "${VERCEL_ENV:-}" = "production" ] || [ "${VERCEL_GIT_COMMIT_REF:-}" = "main" ]; then
  echo "Build can proceed for production."
  exit 1
fi

if [ "${VERCEL_ENV:-}" = "preview" ] || [ -n "${VERCEL_GIT_COMMIT_REF:-}" ]; then
  echo "Skipping Vercel Git preview build; GitHub Actions owns preview checks."
  exit 0
fi

echo "Vercel system variables were not exposed; build can proceed."
exit 1
