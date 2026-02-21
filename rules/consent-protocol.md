---
globs: ["**/*"]
---

# Consent Protocol

When you ask the user a question, request permission, or offer a choice — your turn is **over**.

## The Rule

If your response contains any of:

- A question directed at the user
- A request for approval or permission
- Options presented for the user to choose from

Then you **MUST NOT** take any action related to that question in the same response. No tool calls,
no file edits, no commands. Wait for the user's answer, then act.

## Why

Acting before receiving an answer makes the question meaningless. It undermines user trust and
removes their ability to say no.

## What Counts as a Question

- "Want me to X?" / "Should I X?" / "Can I X?"
- "Which approach do you prefer?"
- "Is it okay if I X?"
- Any sentence ending in `?` that expects a user decision

## What Doesn't Count

- Rhetorical questions in explanations ("Why does this work? Because...")
- Self-directed reasoning ("What if I try X?" followed by investigating)
- Informational questions answered in the same message ("What changed? Here's the diff:")
- Questions about code behavior you're actively investigating

## Valid Patterns

```
# CORRECT: Ask then stop
"I see two approaches: A or B. Which do you prefer?"
[end of response — wait for answer]

# CORRECT: Act without asking
[rename the folder]
"Renamed agent-skills to agentkit."

# WRONG: Ask then act anyway
"Want me to rename the folder?"
[immediately renames the folder]
[end of response]
```
