# pi-branch-ask

Interactive `ask` tool extension for [pi coding agent](https://pi.dev/) with single/multi-select questions and branching flows. Agent can prepare multiple questions and branch them depending on user's answers.

## Install

```bash
pi install npm:pi-branch-ask
```

Or from git:

```bash
pi install git:github.com/egornomic/pi-branch-ask
```

## Usage

Once installed, the extension registers a `branch-ask` tool for interactive questionnaires with branching logic.

## How it works

### Run A: user picks "Fix a bug"

```text
What do you want to do?
> 1. Fix a bug
  2. Build a feature

How bad is the bug?
> 1. Critical
  2. Minor
```

Returned summary:

```text
goal: 1. Fix a bug
severity: 2. Minor
scope: (not asked)
```

### Run B: user picks "Build a feature"

```text
What do you want to do?
  1. Fix a bug
> 2. Build a feature

How big is the feature?
> 1. Small
  2. Large
```

Returned summary:

```text
goal: 2. Build a feature
severity: (not asked)
scope: 1. Small
```

This is the key behavior: the second question changes immediately based on the user's first choice.
