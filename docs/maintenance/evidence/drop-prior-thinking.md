# Prior-thinking retention live evidence

Linux; Node v22.22.1; SDK 0.2.141; CLI 2.1.284; model `claude-opus-5-5`; Pi-shaped streaming HTTP.

| Flag | Request | Input | Cache read | Cache write | Output | Prompt | Growth | Visible chars/4 | Thinking deltas | Tool calls |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| off | 1 | 2 | 0 | 2648 | 3028 | 2650 | — | 687 | 17 | 0 |
| off | 2 | 4 | 2648 | 3227 | 1770 | 5879 | 3229 | 536 | 9 | 0 |
| off | 3 | 4 | 5875 | 1863 | 112 | 7742 | 1863 | 12 | 2 | 1 |
| off | 4 | 2 | 7738 | 156 | 119 | 7896 | 154 | 33 | 1 | 1 |
| off | 5 | 2 | 7894 | 161 | 96 | 8057 | 161 | 40 | 0 | 1 |
| off | 6 | 2 | 8055 | 138 | 98 | 8195 | 138 | 60 | 0 | 0 |
| off | 7 | 4 | 8193 | 127 | 1888 | 8324 | 129 | 536 | 10 | 0 |
| off | 8 | 4 | 8320 | 1913 | 904 | 10237 | 1913 | 369 | 3 | 0 |
| on | 1 | 2 | 2297 | 520 | 2657 | 2819 | — | 699 | 12 | 0 |
| on | 2 | 4 | 2297 | 1805 | 2216 | 4106 | 1287 | 623 | 11 | 0 |
| on | 3 | 4 | 4102 | 1087 | 147 | 5193 | 1087 | 20 | 2 | 1 |
| on | 4 | 2 | 5189 | 191 | 132 | 5382 | 189 | 35 | 1 | 1 |
| on | 5 | 2 | 5189 | 287 | 90 | 5478 | 96 | 32 | 0 | 1 |
| on | 6 | 2 | 5189 | 380 | 163 | 5571 | 93 | 86 | 1 | 0 |
| on | 7 | 4 | 5569 | 162 | 1914 | 5735 | 164 | 569 | 8 | 0 |
| on | 8 | 4 | 5731 | 909 | 866 | 6644 | 909 | 418 | 3 | 0 |

16 requests, each exactly one actual SDK/API generation; six sequential client tool calls; all HTTP 200. Thinking and signatures streamed in both modes. Actual upstream shapes: on, completed turns retain zero thinking; tool continuations retain only newest assistant API message; off, cumulative thinking. Native assistant history present in all continuation API requests proves resume, not client replay.

Aggregate prompt growth off: 7,587 vs preceding billed output 7,111. On: 3,825 vs preceding billed output 7,319. Steady cache reads (requests 3–8): off 91.33%, on 91.08%; final on cache read 5,731 / total prompt 6,644.

**Estimator caveat:** growth is not literally equal to displayed chars/4 (on visible estimate 2,064). Opus summarized thinking understates full reasoning, mathematical text tokenizes poorly, new user/tool results add input, and retained newest tool thinking moves between requests. The decisive proof is absence of older thinking/signatures in actual upstream payloads and roughly halved prompt growth with stable high cache reads.

Live mechanism probe: `CLAUDE_CODE_EXTRA_BODY` successfully supplied context-management beta `clear_thinking_20251015 keep thinking_turns=1`, but earlier thinking remained throughout an open multi-step tool loop. Direct older-message deletion retaining newest API message was accepted by Opus 5.5 in that loop. Consequently transcript pruning chosen.

Earlier failed exploratory gates retained as findings: newest completed answer retention caused cache churn (fixed by dropping completed thinking); two difficult counterfeit tool-loop attempts exercised existing silent-turn recovery, one emitted a client error despite API HTTP 200; a startup-error cleanup guard initially skipped pruning on capped-result exception (fixed/tested). Final simpler three-measurement loop passes without recovery. No claim that long-running arbitrary conversations or every empty-turn recovery is proven.

Verification: targeted 13 pass, 0 fail; original mocked regression red 2 fail / 3 pass before wiring, pure regression red 4 fail before implementation. Full suite: 5,033 pass, 1 skip, 0 fail with official scratch Node 22.22.1 and replay-budget isolation. Vanilla npm test first block: 4,729 pass, 1 skip, 3 fail (existing two models-mock collision cases and distro Node without TypeScript). Official Node baseline run additionally exposed unrelated reporter cleanup race; isolated reporter/attachment 19 pass. Typecheck/build/diff-check green. No lint script defined.

Frontier reviews: gpt-6.1-sol scoped approach approved; final Opus 5.5 scoped code review no material blocking findings. Remaining lows: sibling-ENOENT fault injection and standalone thinking-only-message API edge not live covered; abrupt death may orphan a private temp file. Fail-closed pruning retained deliberately rather than silently resending history.

No production service changes. Scratch listeners closed, isolated auth/config/session state removed. No push, PR, merge or install.
