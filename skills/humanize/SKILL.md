---
name: humanize
description: >-
  Rewrite text so it reads like a person wrote it — strip AI writing tells
  (stock vocabulary, significance inflation, negative parallelism, chatbot
  filler, em-dash pile-ups, formulaic structure) while preserving every fact,
  claim, and the author's voice. Use on drafts, docs, READMEs, issue and MR
  bodies, announcements, or any prose that smells generated. Triggers:
  "humanize this", "make this sound human", "remove the AI tells", "this reads
  like AI", "deslop this text".
---

# humanize

Rewrites prose to remove the patterns that mark text as machine-generated.
Adapted from blader/humanizer and conorbronsdon/avoid-ai-writing (both MIT; see
NOTICE), tuned for the terse, diagram-friendly documentation style the other
agentkit rules already mandate.

## Contract

- **Facts are immutable.** Every claim, number, name, and link in the input
  survives the rewrite. Never invent a fact to smooth a sentence.
- **Voice is the author's, not yours.** If the input has a discernible voice or
  the user supplies writing samples, match them. Sterile, voiceless output is
  as obvious as slop.
- **Code, data, and URLs are untouchable.** Fenced blocks, inline code, tables
  of values, and links pass through byte-identical.
- **Length goes down.** A humanized text is almost always shorter. If yours
  grew, you added padding, not humanity.

## Pass 1 — strip the tells

Work through the text once, rewriting every instance of:

| Category               | Examples                                                                                                                                                                                                               | Fix                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Stock vocabulary       | delve, tapestry, plethora, myriad, treasure trove, synergy, paradigm shift, game-changer, cutting-edge, groundbreaking, revolutionize, seamless, holistic, leverage, embark on, harness, unlock the potential, elevate | The plain word: use, start, big, new, works with                  |
| Significance inflation | "a testament to", "plays a crucial role", "underscores the importance", "evolving landscape", "pivotal moment", "in today's fast-paced world"                                                                          | State the specific fact that made you want to inflate             |
| Negative parallelism   | "not just X, but Y", "it's not X — it's Y", "more than just X"                                                                                                                                                         | Say what it is, once                                              |
| Chatbot register       | "great question", "I hope this helps", "let's dive in", "without further ado", "it's worth noting", "certainly!"                                                                                                       | Delete                                                            |
| Hedging stacks         | "could potentially", "it may be possible that", "arguably"                                                                                                                                                             | One hedge maximum, and only if the uncertainty is real            |
| Em-dash pile-ups       | several — per paragraph                                                                                                                                                                                                | Periods and commas; keep at most the one that earns it            |
| Rule-of-three padding  | "fast, reliable, and scalable" where one word carries the meaning                                                                                                                                                      | Keep the word that matters                                        |
| Formula structure      | every paragraph the same length, every section "X: explanation", inline-header bullet lists                                                                                                                            | Vary; merge; or convert to a table when the content is enumerable |
| Empty openers/closers  | "In conclusion", "Overall", "In summary", restating the intro at the end                                                                                                                                               | Delete; end on the last real point                                |

## Pass 2 — critique and finish

Reread the rewrite as a hostile editor:

1. Scan for tells that survived pass 1 or crept into your own rewording (the
   common failure: replacing one stock phrase with another).
2. Diff the claims against the original — every fact present, none invented.
3. Read one paragraph aloud in your head. If the cadence is uniform, break it:
   a short sentence after a long one, a concrete example where three
   abstractions stood.
4. Confirm code blocks, links, and data are byte-identical to the input.

Deliver the rewrite plus a one-line note of anything you deliberately kept
(e.g. a stock phrase inside a quotation, which is the author's to keep).

## What this skill is not

- Not a paraphraser for evading AI-detection tooling in contexts where AI
  disclosure is required (coursework, journalism with disclosure policies).
  If that is the request, decline and say why.
- Not a fact-checker. It preserves claims; it does not verify them.
- Not the enforcement layer. The `prose-police` hook catches new slop at
  write time; this skill is the wholesale cleanup for existing text.
