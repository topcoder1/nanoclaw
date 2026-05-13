# Regression Test Convention

This directory holds tests that lock in fixes for the lessons logged under
`## Lessons` in this repo's lessons file(s).

## Rule

When you append a bullet to `## Lessons`, also add a file in this directory:

- Name: `test_<short-slug>.<lang>` (`.py` for Python, `_test.go` for Go, `.test.ts` for TS, `.spec.js` for JS).
- Body: a test that would have caught the original burn — fails on the pre-fix
  code, passes on the post-fix code.
- Comment header: link the test to the lesson by quoting the bullet's date
  prefix (e.g. `# Lesson 2026-05-03: …`).

## Enforcement

A CI check (`Regression Convention / Lessons must have tests`) fails any PR
that modifies `## Lessons` in the configured lessons file(s) without adding or
modifying a file in `tests/regression/`.

## Configured lessons files (set at install)

``

## Why

Lessons without tests are vibes. The next AI agent reading the lessons file
won't know the rule still holds — and the bug will be re-introduced. Tests pin
the lesson to the runtime.

🤖 Created by `install-regression-convention.sh`
