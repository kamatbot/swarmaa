# Review of the Codex Mac app fixes (Claude, 2026-10-28)

Static review of swarmaa/codex/99127914 (0681863). Line numbers refer to that branch; paths are under Mac-app/Sources.

**Recommendation: don't merge yet.** This was a static review of `git diff main...swarmaa/codex/99127914 -- Mac-app` (commit `0681863`) against `src/core/teams.ts`, `swarms.ts`, `tasks.ts` and `http.ts` on main. I didn't build, run tests or launch the app. Line numbers refer to the branch.

## Findings, most severe first

1. **High: messages can go missing after the window is closed and reopened (check 3).** Closing the window stops the stream (`TeamsWindow.swift:46-48`), but the model keeps its cached messages.
   - On reopen, `refresh` calls `loadLatest(selected)` (`TeamsModel.swift:209`), which fetches the newest 50 and merges them by id (`:357`). If more than 50 messages arrived while the window was closed, the ones in between are silently lost. `loadOlder` pages back from the oldest message (`:346`), so it never fills that gap.
   - Any other cached thread is worse: `select` only loads when `messages[t] == nil` (`:326`), so it shows stale history. It then sends a mark-read for the stale last seq.
   - Example: close the window, a swarm posts 120 messages overnight, reopen. Messages 51–70 never appear and nothing on screen says so.
   - Fix: when the cache exists, page forward with `after_seq` from the last cached seq instead of reading the newest page.

2. **High: a failed send can block that thread's composer (check 2).** `sendDraft` keeps the failed message (`pendingSends[t]`) and every Send retries it (`:386`). Only a success clears it, and there is no discard control (`ThreadView.swift:530-533`).
   - Errors that retrying can't fix keep it stuck: `not_found` for an archived thread, `owner_required`, or a 400 for an over-long body. The user can type new drafts but can never send them until the app restarts.
   - The targeting itself is correct: a send goes to the thread it was typed in, a failure doesn't overwrite newer text, and the idempotency key is reused only for the same draft.

3. **Medium: an open, visible thread can keep an unread badge (check 4).**
   - `apply` now always calls `badges.created(..., authorKind: nil, isOpen: false)` (`:505`), so every message raises the badge, even in the open thread.
   - When two messages arrive close together, the second `markSelectedRead` is dropped because the first is still pending (`:373`). The first then doesn't clear the badge, because its seq is below the new `lastSeq` (`:381`). Nothing retries, so the badge stays at 1 and the service's read position lags.
   - Passing `nil` as the author also means the owner's own posts from another client (phone, Dot) now count as unread.

4. **Medium: resolved tasks are refetched without limit (check 8).** `taskList` now uses `allPages` (`SwarmaTeamsClient.swift:683`). `loadTasks` pages through every resolved task in every scope, three listings per scope, on each refresh and each `task.updated` (`TeamsModel.swift:740-744`).
   - A scope with more than 5,000 resolved tasks hits the 100-page cap and throws. The new data is only assigned after the loop (`:745`), so the Tasks and Needs-you panes never update again and the Offline banner stays up.

5. **Low: a question target that is never found leaks into other threads.** `targetQuestionID` is shared across threads and is only cleared once the question is found (`ThreadView.swift:1354-1365`). If its message isn't there, every thread opened afterwards pages back through its entire history looking for it.

6. **Low: a 409 `task_active` leaves the row stale (check 5).** Resolve is correctly hidden for queued and running tasks (`TeamsTasks.swift:1005`, `TasksViews.swift:589`). The client-side guard plus the HTTP/MCP mapping in `SwarmaClient.swift:117,125` gives the intended message. But on failure `withTask` returns before `loadTasks()` (`TeamsModel.swift:800`), so the row's state isn't refreshed.

7. **Low: Dock click during first-run onboarding (check 6).** `applicationShouldHandleReopen` now always calls `openTeams()` (`AppDelegate.swift:13`). During onboarding that opens the main window on top of the onboarding window and starts setup probes against an unconfigured service. Calling `onboarding?.show()` first when it is showing would fix it. Settings is unaffected: ⌘, and the gear button still open it.

8. **Low: message text renders blank for a moment.** `TextBubble` now parses Markdown in `.task` (`ThreadView.swift:1467`), which still runs on the main thread. Each bubble shows empty text for a frame, then grows, which can make the scroll jump.

## Per check
1. **Decoders:** no issues. They match the `threadRead` output (`teams.ts:648-664`) and `swarmView`. The fallbacks are right: `swarm_get` when no swarm is embedded, plain text when no question is. The default page is the newest, ascending, and `has_more` means older messages exist.
2. **Drafts:** finding 2.
3. **Paging:** finding 1. Both directions dedupe by id. `message.created` pages forward only for the open thread and otherwise just updates the cached tail.
4. **Unread:** finding 3. The visibility check itself (`isVisible && pane == .agents`, plus resign-key) is correct.
5. **Resolve:** finding 6.
6. **Dock click:** finding 7.
7. **Notch files:** nothing beyond what the brief allowed.
   - `ProviderRing.swift` adds only a button trait and an accessibility action. It calls `AppDelegate.shared` directly rather than the fleet's `onOpenThread` callback (harmless).
   - `NotchWindowController.swift:1576` now passes the cell's `/swarm/<id>` suffix, so a press also opens that swarm. That changes what `onOpenThread` receives, but its only consumer, `AppDelegate.openTeams` (`AppDelegate.swift:313`), handles both forms.
8. **Main thread and retain cycles:** no retain cycles. The stream and setup closures capture `self` weakly; `scheduleTaskRefresh` and `markSelectedRead` hold it strongly only briefly. No main-thread blocking beyond finding 8.

The service-code mapping is also fine. Over REST an unknown tool returns 404 `unknown_tool` (`core/index.ts:67`), which still maps to "service too old", and routing's "read-only" state still works because `routing_set` doesn't return `owner_required`.

## Next steps
Fix findings 1–3, then cap the resolved-tasks fetch to one page. Add regression tests for the reopen gap, a pending send that can't succeed, and back-to-back `message.created` events on the open thread.

**Don't merge.**

## Found by the coordinator's full test run

- **LessonReviewTests.testForbiddenIsShownAndNothingChanges fails:** `Failure.forbidden.message` changed from "This Mac's Swarmaa connection can't review lessons yet" to a generic line. Lesson review must keep its specific message; put it in LessonReviewModel's error mapping, not in the shared Failure, and keep the generic text everywhere else. The test passes on main.
- **OllamaPerformanceViewTests.testAllSpeedBandsAndThinkingRenderOnAllFourEdges** failed once in the full suite (992.5 > 982.1, left/right small) but passed twice alone. It is order-dependent, not caused by this branch. Leave it.
