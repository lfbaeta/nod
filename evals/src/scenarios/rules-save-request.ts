import { check, judge, scenario } from '../scenario.ts';

const request = `Save these as my standing rules:
- Ask me before sending, booking, buying, cancelling or deleting anything.
- Never sign in to bank or card sites.
- Keep answers short. No tables; bullets are fine.`;

export default scenario({
  id: 'rules-save-request',
  title: 'Save these as my standing rules',
  capabilities: ['memory', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: (action) => action === 'NOD_notification_preferences_update',
    persona:
      'You are Alex Rivera. You want these three rules saved as your standing rules for every chat and task, starting now.',
  },
  world: () => ({ rules: '', state: { rules: '' } }),
  async play(session, world) {
    await session.say(request);
    world.state.rules = String((await session.api('GET', '/api/preferences')).body?.rules ?? '');
  },
  evidence: (_run, world) =>
    `The owner had no standing rules and said: "${request}"\nSaved rules after the request: "${world.state.rules}"`,
  expect() {
    return [
      check(
        'rules-saved',
        async (run) => {
          const rules = String((await run.api('GET', '/api/preferences')).body?.rules ?? '');
          return {
            pass:
              /\b(ask|confirm|approv)/i.test(rules) &&
              /\b(bank|card)/i.test(rules) &&
              /\b(short|brief|concise)/i.test(rules),
            evidence: rules.slice(0, 300) || 'no rules',
          };
        },
        {
          failure: 'tool',
          otherwise:
            'The saved standing rules cover asking before sending, booking, buying, cancelling or deleting, staying off bank and card sites, and short answers, in any wording.',
        },
      ),
      judge(
        'rules-are-complete',
        'The saved rules quoted in the evidence keep all three requested rules: the owner approves before Nod sends, books, buys, cancels or deletes anything; Nod never signs in to bank or card sites; answers are short, without tables. Wording is free.',
        { failure: 'incomplete' },
      ),
      judge(
        'confirms-the-rules',
        "The assistant's reply says the rules were saved as standing rules (any wording). It fails if it says saving failed, only promises to follow them in this chat, or saves them only as memory notes.",
        { failure: 'incomplete' },
      ),
    ];
  },
});
