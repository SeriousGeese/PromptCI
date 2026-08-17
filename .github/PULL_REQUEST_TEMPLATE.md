<!--
Thanks for contributing to PromptCI.
Keep the title in Conventional Commit style (feat:, fix:, docs:, chore:) — release notes are
generated from labels, and the title is what readers see.
-->

## What this changes

<!-- One or two sentences. What behavior is different after this merges? -->

## Why

<!-- Link the issue this closes: "Closes #123". If there's no issue, explain the motivation. -->

## Detector impact

<!--
Delete this section if you didn't touch packages/core.
Detector changes shift results for everyone, so be explicit:
-->

- New or changed findings:
- Findings this stops producing:
- Ran against a real repo to check for noise: yes / no

## Checks

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Added or updated tests covering the change
- [ ] No generated `.promptci/` output is staged
- [ ] Scanner logic remains deterministic — no LLM or network calls added to detector code
- [ ] Commits are signed off (`git commit -s`) per the DCO — see [CONTRIBUTING.md](../CONTRIBUTING.md)

## Notes for reviewers

<!-- Anything tricky, deliberately out of scope, or that you want a second opinion on. -->
