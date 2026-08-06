import { YAML } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENFORCEMENTS, SCOPES, STRENGTHS } from '../../skills/taste/scripts/lint.ts';
import { VISIBILITIES } from '../../skills/taste/scripts/sources.ts';
import { TARGET_PRIVATE_OVERRIDE } from '../../skills/taste/scripts/visibility.ts';

const repoRoot = join(import.meta.dir, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), 'utf-8');
}

// Named rather than inline so the uniqueness gate below can read every binding
// in the file, instead of restating a list that would drift from them.
const HOOK_BEHAVIOURS: [string, string][] = [
  ['the override is named by the taste', 'that taste\'s named variable'],
  ['off-reading values do not disable it', 'do not count'],
  ['a malformed taste is not contagious', 'takes nothing else down with it'],
  ['an unrunnable hook allows', 'refuses on its own uncertainty'],
  ['the bounds are stated', '200 characters'],
];

const SETTLED_BEHAVIOURS: [string, string][] = [
  ['precedence resolves in one direction', 'project > project external > user > user external > kit'],
  ['a higher scope replaces rather than merges', 'replaces the lower one'],
  ['dedupe happens before anything is written', '**2. Dedupe before writing anything.**'],
  ['a one-off leaves the file alone', '**The file is not touched.**'],
  ['a durable change supersedes in place', 'Supersede the taste **in place**'],
  ['no second file on the same topic', '`release-tier-v2.md`'],
  ['git history is the archive, not a v2 file', 'git history is the archive'],
  ['contradicting a require taste asks first', '**ask outright**'],
  ['the confirm names both readings', 'one-off, or change the taste?'],
  ['a prefer taste updates and says so', 'update it and say that you did'],
];

const CONVERSATIONAL_SURFACES: [string, string][] = [
  ['no command exists, deliberately', 'skill-driven, and there is no CLI'],
  ['listing collapses to the winner', 'one row per name'],
  ['listing carries the scope column', 'the layer the winning file came from'],
  ['listing carries strength and enforce', '| `strength` |'],
  ['listing names what a scope shadowed', 'Name the shadowed layers explicitly'],
  ['an empty folder is said, not tabulated', 'rather than presenting an empty table'],
  ['a skipped taste is named, not omitted', '**named in the listing as skipped**'],
  ['dictation is not a lesser path', 'first-class capture path, not a lesser one'],
  ['dictation runs the same sequence', 'It runs the same Learning'],
  ['dictation still lands through an MR', 'merge request for a project taste'],
  ['dictation asks rather than invents', 'Ask for what dictation did not supply'],
  ['a dictated provenance is never guessed', 'never a guess'],
  ['dictation earns no enforcement', 'does not earn `block` by being dictated'],
  ['learning fires on a dictated taste too', 'or when a taste is dictated'],
  ['every write is linted', 'run `bun <skill-dir>/scripts/lint.ts` on every directory'],
  ['the lint runs before the diff is shown', '**before you show anyone the diff**'],
  ['an unlinted taste is not finished', 'is not written yet'],
  ['the lint rule covers edits as well as captures', 'This holds for every write'],
];

// Phase 3's surface: what a source is, how several stack, and what a sync is
// allowed to do. The sync script performs the mechanics; every decision around
// it — what wins, what is never hand-edited, what a lock bump means to review —
// lives here or nowhere.
const EXTERNAL_SOURCES: [string, string][] = [
  ['a source is subscribed to by committed config', 'ordinary committed config change in `taste.sources`'],
  ['the list is ordered and a later source wins', 'a later source wins'],
  ['vendored is the only mode today', 'the only mode that exists today'],
  ['reference mode is refused, not downgraded', 'an error naming the deferral'],
  ['a fresh clone reads its policy with no network', 'already has the policy'],
  ['a ref cannot smuggle a git option', 'a program git would'],
  ['a repo cannot name a transport helper', 'runs a program instead of fetching'],
  ['the lock pins the commit that was reviewed', 'the commit whose contents were reviewed'],
  ['the pin date moves only with the pin', 'The date moves only when the pin does'],
  ['the vendored tree is never hand-edited', 'Never edit `.agentkit/tastes/external/` by hand'],
  ['a repository deviates with a project taste', 'to deviate in one repository, write a project taste'],
  ['an undeclared vendor directory binds nothing', 'only a declared one is read'],
  ['sync lints before it copies', '**lints it before anything is copied**'],
  ['a refused source lands nothing at all', 'nothing enters the tree'],
  ['sync writes those two paths and no others', 'Only those two paths are ever written'],
  ['a dropped source loses its vendored copy', 'has its vendored copy removed'],
  ['nothing executable is vendored', 'nothing executable ever crosses'],
  ['an unchanged re-sync is an empty diff', 'produces no diff at all'],
  ['a lock bump is reviewed as the text itself', 'the exact text your agents will start'],
  ['a version number is not a review', 'Approving a version number instead of the words'],
  ['listing names the source an external row came from', 'which declared source it was vendored from'],
  ['a source correction is written upstream', 'copied into this one'],
];

// One folder with two origins, rather than two folders implying two concepts.
// Where a file sits decides which layer it lands in, so the prose that says
// where things sit is the prose an agent resolves by.
const LAYOUT: [string, string][] = [
  ['the tastes folder holds both origins', '**One tree, two origins.**'],
  ['a source is snapshotted beneath it, not beside it', 'sits beneath it in `external/`'],
  ['external is reserved at the tastes root', '`external` is therefore reserved'],
  ['nothing under external is a project taste', 'is ever counted as one'],
  ['the tastes root is linted in one invocation', 'the repository\'s own tastes are one scope'],
  ['the old location keeps working for one release', 'for one release of grace'],
];

// Two install modes, both product features. Which one an owner wants is a
// decision the skill has to be able to answer, and the answer is this prose:
// nothing else in the tree says what a scope is for.
const INSTALL_MODES: [string, string][] = [
  ['where a source is declared decides where it lands', '**decides where its snapshot lands**'],
  ['machine-level is declared once for every repository', 'every repository picks it up'],
  ['nothing machine-level can reach a public repository', 'so nothing can leak into a public one'],
  ['a private set belongs at the machine level', 'A private set belongs here'],
  ['repository-level travels with the clone', 'the policy has to travel with the clone'],
  ['a container agent is why repository-level exists', 'an agent running in a container'],
  ['both scopes may be declared and both apply', '**Both may be declared, and both apply.**'],
  ['neither list replaces the other', 'neither list replaces the other'],
  ['two stores carry two locks', 'Two stores means two locks'],
  ['the more specific location wins', 'The more specific'],
  ['an owner\'s own beats what they pulled in', 'beat the ones they pulled in'],
  ['sync refreshes both scopes that apply', 'refreshes both scopes that apply'],
  ['outside a repository only the machine scope runs', 'only the machine scope has anything to do'],
];

// The guard, and the incident that produced it. Every clause here is a
// refusal the code performs; prose that drifted from one would answer for the
// wrong tool.
const VENDOR_GUARD: [string, string][] = [
  ['vendoring publishes the source\'s words', 'commits a source\'s words'],
  ['the leak is named as the reason', 'prose does not stop a sync'],
  ['visibility is required of a repository\'s source', 'required of a source a repository vendors'],
  ['a private source cannot enter a public repository', 'refused entry to a public repository'],
  ['the target is read from its forge', '`gh` for a GitHub remote'],
  ['the forge is asked about origin by name', 'asked about `origin` by name'],
  ['a second remote cannot answer for the checkout', 'judged by a repository nobody named'],
  ['an undeterminable target is refused too', '**It fails closed.**'],
  ['internal is on the public side', '**Internal is not private.**'],
  ['the machine level is gated once it publishes', 'gated only when it publishes'],
  ['a dotfiles repository is the shape it exists for', 'a dotfiles repository is the shape'],
  ['the override is named', 'AGENTKIT_TASTE_TARGET_PRIVATE=1'],
  ['the override supplies only what was unknown', 'stays refused with it set'],
  ['off-reading values do not grant it', 'are refusals here too'],
];

// Loading is whole-file, and the reason is the one that decides it: an
// abridged taste is acted on with confidence, and "read the body when it
// matters" is a prose discipline of exactly the kind this repository has
// already watched get routed around.
const LOADING_STRATEGY: [string, string][] = [
  ['a taste that loads, loads whole', '**A taste that loads, loads whole.**'],
  ['no summary and no first-sentence stand-in', 'Never a summary, never a first sentence'],
  ['a partial preference is the worse failure', 'A partial preference is worse than an absent one'],
  ['read-it-later is a prose discipline', 'is a **prose'],
  ['instructions alone get routed around', 'demonstrably routed around'],
  ['the one-MR cap is the evidence', 'bypassed eleven times'],
  ['abridging repeats the failure tastes exist to fix', 'the failure the system was built to fix'],
  ['selection is structural rather than lossy', '**structural, not lossy**'],
  ['filtering picks which, never how much', 'Filtering decides which tastes load'],
  ['category is what a filter reads', 'Filter by `category` against the work in front of you'],
  ['check, block and require survive every filter', '**Regardless of category, always load**'],
  ['a filtered load is declared, not implied', 'say plainly that you filtered'],
  ['blocking enforcement is unaffected', '`enforce: block` is unaffected by any of this'],
  ['filtering never changes what stops you', 'never what stops it'],
];

// The design this replaced, asserted absent rather than trusted to review. It
// was on this branch once and read plausibly; a future edit that reintroduces
// the vocabulary is reintroducing the failure mode, not rephrasing.
const REVERSED_DESIGN = [
  'Keep an index, not the corpus',
  'index line',
  'When in doubt, read the body',
  'Category touch',
];

// The single-store design, asserted absent for the same reason. Both sentences
// were true and reasonable while a machine declaration vendored into whatever
// repository you happened to be in; restoring either would restore a scope that
// goes silent the moment another one is declared.
const REVERSED_SCOPES = [
  'A project list replaces the user list',
  'project > external > user > kit',
];

const skill = read('skills', 'taste', 'SKILL.md');
const reference = read('skills', 'taste', 'references', 'format.md');
const example = read('config.example.yaml');

describe('the taste skill and its contract agree', () => {
  test('the skill declares the name the installer keys on', () => {
    const front = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '') as {
      name?: string;
      description?: string;
    };
    expect(front.name).toBe('taste');
    expect(front.description).toContain('from now on');
  });

  test('every value the lint accepts is documented in the format reference', () => {
    for (const value of [...SCOPES, ...STRENGTHS, ...ENFORCEMENTS]) {
      expect(reference, `format.md documents ${value}`).toContain(`\`${value}\``);
    }
  });

  test('the config keys the skill reads ship in config.example.yaml, both on', () => {
    const config = YAML.parse(example) as { taste?: Record<string, unknown> };
    expect(config.taste).toEqual({ enabled: true, learning: true });
    expect(skill).toContain('taste.enabled');
    expect(skill).toContain('taste.learning');
    // Both ends of the fallback chain: a skill that read only the user config
    // would ignore the repository's own settings, which is where a project's
    // opt-out lives.
    expect(skill).toContain('.agentkit/config.yaml');
    expect(skill).toContain('~/.config/agentkit/config.yaml');
  });

  // Commented rather than set: an empty sources list in the shipped example
  // would be a declaration nobody made, and the parse above is what keeps it
  // that way.
  test('the example documents sources without subscribing anyone to one', () => {
    expect(example).toContain('# sources:');
    expect(example).toContain('mode: vendored');
    expect(example).toContain('deferred');
  });

  // The hook now exists, so the honest sentence changed direction: prose that
  // still said block was inert would understate enforcement the same way the
  // phase-1 prose would have overstated it.
  test('the skill describes block as the hook that performs it', () => {
    expect(skill).not.toContain('`block` behaves exactly like `check`');
    expect(skill).toContain('`taste-police`');
    expect(skill).toContain('UNCHECKED');
  });

  // Every edge the hook has, said in the words an agent answers with. The skill
  // is what a session reads when someone asks why a block did or did not fire.
  test.each(HOOK_BEHAVIOURS)('the skill carries the hook behaviour: %s', (_behaviour, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  // The skill is the whole mechanism in this phase: nothing executes these rules,
  // so a behaviour silently dropped from the prose is a behaviour that stops
  // happening. Each entry is a decision the design settled, bound to the words
  // that carry it.
  test.each(SETTLED_BEHAVIOURS)('the skill still carries the behaviour: %s', (_behaviour, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must still say: ${phrase}`).toBe(true);
  });

  // The three surfaces a CLI would have carried. The owner's decision is that
  // the skill performs them conversationally, which makes this prose the whole
  // implementation — a sentence dropped here is a capability that stops
  // existing, with no compiler and no hook to notice.
  test.each(CONVERSATIONAL_SURFACES)(
    'the skill carries the conversational surface: %s',
    (_surface, phrase) => {
      expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
    },
  );

  test.each(EXTERNAL_SOURCES)('the skill carries the external-source rule: %s', (_rule, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  test.each(LAYOUT)('the skill carries the layout rule: %s', (_rule, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  test.each(INSTALL_MODES)('the skill carries the install mode: %s', (_mode, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  test.each(VENDOR_GUARD)('the skill carries the vendoring guard: %s', (_rule, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  // The refusal an owner meets is performed by vendor-guard.ts and explained
  // here, so the two have to name the same variable.
  test('the override the skill names is the one the guard reads', () => {
    expect(skill).toContain(TARGET_PRIVATE_OVERRIDE);
    expect(reference).toContain(TARGET_PRIVATE_OVERRIDE);
  });

  test('the format reference documents both visibility values', () => {
    for (const value of VISIBILITIES) {
      expect(reference, `format.md documents visibility: ${value}`).toContain(`\`${value}\``);
    }
    expect(reference).toContain('visibility');
  });

  // Every session pays for the loading strategy, and nothing but this prose
  // performs it: a clause dropped here is a habit that stops happening, with no
  // hook and no compiler to notice.
  test.each(LOADING_STRATEGY)('the skill carries the loading rule: %s', (_rule, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  test.each(REVERSED_DESIGN)('the skill no longer offers a taste in summary: %s', (phrase) => {
    expect(
      skill.includes(phrase),
      `SKILL.md must not say ${JSON.stringify(phrase)} — a taste loads whole, and this is the `
        + 'vocabulary of the abridged-loading design that was reversed',
    ).toBe(false);
  });

  test.each(REVERSED_SCOPES)('the skill no longer has one scope shadow the other: %s', (phrase) => {
    expect(
      skill.includes(phrase),
      `SKILL.md must not say ${JSON.stringify(phrase)} — both scopes apply and each vendors into `
        + 'its own store, and this is the vocabulary of the single-store design that was reversed',
    ).toBe(false);
  });

  // A phrase split across a line break would bind nothing: the file it is read
  // from is hard-wrapped, and `textWrap: maintain` leaves the author's breaks
  // exactly where they fell.
  test.each([...LAYOUT, ...LOADING_STRATEGY, ...INSTALL_MODES, ...VENDOR_GUARD])(
    'the phrase bound for %s sits on one line',
    (_rule, phrase) => {
      expect(phrase.includes('\n')).toBe(false);
      expect(skill.split('\n').some((line) => line.includes(phrase))).toBe(true);
    },
  );

  // A substring binding is only as strong as its phrase is distinctive: an echo
  // elsewhere keeps it green while the paragraph it names is rewritten to say
  // the opposite. Uniqueness is what points a binding at one place.
  test.each([
    ...HOOK_BEHAVIOURS,
    ...SETTLED_BEHAVIOURS,
    ...CONVERSATIONAL_SURFACES,
    ...EXTERNAL_SOURCES,
    ...LAYOUT,
    ...LOADING_STRATEGY,
    ...INSTALL_MODES,
    ...VENDOR_GUARD,
  ])(
    'the phrase bound for %s occurs exactly once in SKILL.md',
    (_behaviour, phrase) => {
      expect(
        skill.split(phrase).length - 1,
        `${JSON.stringify(phrase)} must appear once — an echo elsewhere in SKILL.md means this `
          + 'binding no longer holds the paragraph it names',
      ).toBe(1);
    },
  );

  // A PATH tool is the thing the owner rejected, so its absence is asserted on
  // the tree rather than trusted to review.
  test('no taste command ships in tools/', () => {
    const tools = readdirSync(join(repoRoot, 'tools'));
    expect(tools.filter((name) => name.includes('taste'))).toEqual([]);
  });

  test('the routing heuristic keeps an unclear correction out of the public set', () => {
    expect(skill).toContain('the private central set, as the safe default');
    expect(skill).toContain('owner-approved');
  });
});
