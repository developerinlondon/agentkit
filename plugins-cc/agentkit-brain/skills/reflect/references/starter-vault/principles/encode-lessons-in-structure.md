# Encode Lessons in Structure

Recurring fixes belong in mechanisms — hooks, lint rules, runtime checks,
scripts — not in textual instructions. Instructions require the reader to
notice, remember, and comply; mechanisms enforce without cooperation.

When you catch yourself writing the same instruction a second time:

1. Can it be a lint rule, metadata flag, runtime check, or script? Encode it
   there and delete the instruction.
2. If it genuinely requires judgment, make the instruction prominent and attach
   the concrete failure it prevents.

Route every correction: one-off → brain note; recurring fix → skill or rule;
systemic → principle. Recording without routing is waste — apply the fix now or
file a concrete issue.
