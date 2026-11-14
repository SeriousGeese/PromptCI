# Agent Guidelines

Fixture for the grouped, unscored findings (pcic-1ik0.3): this file names none of the common
agent practices, and `.github/workflows/ci.yml` uses three actions by tag. The scan should report
ONE agent-practice finding for the repository and ONE action-pin finding for the workflow, both
`info` and both left out of the health score.

## Stack

This is a small TypeScript library. Source lives in `src/`, tests next to the code they cover.
