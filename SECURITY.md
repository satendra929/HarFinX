# Security Policy

## Supported versions

HarFinX is early-stage (v0.0.x). Only the latest commit on `main` receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting: open this repository's **Security** tab and choose **Report a vulnerability**. Include what you found, the steps to reproduce it, and the version or commit.

You can expect an acknowledgement within 30 days. Fixes are released as soon as they are ready, and you will be credited unless you prefer otherwise.

## What is in scope

HarFinX reads files in one workspace folder and talks to a local model by default. Reports of these kinds are especially welcome:

- reading or writing outside the workspace folder (path traversal, symlinks, drive roots)
- file contents or questions leaving the machine when a local model is configured
- secrets or personal data written to logs or output
- a crafted file (PDF or text) that makes the harness run code, exhaust memory, or call a tool it should not

## Out of scope

- wrong or misleading model answers (check every figure against the cited source)
- problems in Ollama, the model, or other third-party software; please report those to their own projects
- findings that need an attacker who already controls your machine or your `.env`

## Handling your data

The audit log (`audit/`) holds your questions, answers and file contents. It stays on your machine and is git-ignored. Do not attach it, or any file from your workspace, to a public report.
