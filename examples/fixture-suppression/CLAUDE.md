# Fixture: Suppression Annotations

Test fixture for promptci-ignore annotation parsing.

## Valid Suppression

<!-- promptci-ignore: vague_guidance
     reason: This section documents examples of vague guidance that PromptCI detects, not real guidance. -->
Write clean code. Use best practices. Keep it simple.

## Invalid — Missing Reason

<!-- promptci-ignore: stale_instruction -->
This instruction was last updated in 2021 and references an old library.

## Invalid — Bad Category

<!-- promptci-ignore: not_a_real_category
     reason: Testing invalid category handling. -->
Some content here that would otherwise be ignored.

## Unsuppressed Vague Guidance

This section has no suppression annotation.
Write clean code. Use best practices.

## Range Suppression

<!-- promptci-ignore-start: stale_instruction
     reason: Legacy migration notes kept for historical context only. -->

This content was valid in 2020 when we used the old framework.
Migration was planned for Q3 2021 but was deprioritized.

<!-- promptci-ignore-end -->

## Normal Content

Always use TypeScript strict mode.
Run pnpm lint && pnpm test before committing.
Never expose API keys in source code.
