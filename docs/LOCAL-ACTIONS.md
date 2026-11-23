# Local actions (Reminders, Calendar, timers, notes)

A ring or Watch memo such as "remind me to call mom at 5" becomes a real item with no LLM in the path. The service picks from a closed set of four actions and runs them on the iPhone (when allowed there) or on the Mac that hosts it. Design: [RING-AGENT.md](RING-AGENT.md) §5 and §7. Code: `src/local/actions.ts` (runner), `src/local/jxa.ts` (the one fixed JXA script) and `src/local/notebook.ts` (markdown notebook).

## Phone first, Mac fallback (RING-AGENT.md §11)

Reminders, events and timers/alarms from a ring memo run **on the iPhone** when the app has been allowed to (Swarmaa › This iPhone); iCloud then syncs them to the Mac. The Mac path below stays as the fallback and is unchanged.

| Action | Runs on the iPhone when the phone sends | Otherwise |
|---|---|---|
| `reminder.create` | `reminders` | Mac (JXA) |
| `event.create` | `calendar` | Mac (JXA) |
| `timer.start` | `alarms` (AlarmKit, iOS 26) **or** `reminders` (a `⏱` reminder); the phone picks | Mac (JXA reminder) |
| `note.append` | never | Mac notebook |

- The phone lists its allowed capabilities in `voice_intent.device_actions` (with its `device_id`). A matching action is stored with `runner='device'`, the card says "… · waiting for your iPhone", and the response (`route: 'device'`) carries the action for the phone to save. The phone reports the outcome with `local_action_report`; the card then reads "Reminder set: …".
- If the Mac is asked first (capability not advertised) and ends `permission_denied`, `action_disabled` or `unavailable`, and the request carried `device_actions` at all, the action moves to the phone (queued, 24 h) instead of going to the Assistant. The phone asks for the permission and runs it once granted.
- Older phone apps (no `device_actions`), Assistant turns, `local_action_run` and the Watch always use the Mac, as before.
- Undo from a thread card puts a device action in `undoing`; the phone deletes it on its next contact (`local_action_pending`, `voice_warm` answering `device_pending > 0`, or after any memo) and reports `undone`. The notification's Undo on the phone is immediate.
- The service sweep never runs a device action. One still queued after 24 h fails with "your iPhone didn't pick it up" (a later `done` report still wins); an undo left for 24 h returns to `done`.

Which permission is asked where:

| Where | Permission | Used for |
|---|---|---|
| iPhone (Swarmaa › This iPhone) | Reminders full access, Calendar full access (add-only works but cannot undo), Alarms (AlarmKit) | device actions |
| Mac (System Settings › Privacy & Security › Automation) | Swarmaa → Reminders, Calendar | fallback, Assistant turns, tools |

A device permission failure reads, for example, `Couldn't set the reminder: allow Reminders in Swarmaa › This iPhone on your iPhone`. All card text is written by the service from the action and the code; the phone never sends free text.

## What each action does on the Mac

| Action | Effect | Card | Undo |
|---|---|---|---|
| `reminder.create` | Reminder in `SWARMAA_REMINDERS_LIST` (or `SWARMAA_TODO_LIST` for to-dos), with a due date and alert when a time was spoken | `Reminder set: Call mom · Today 17:00` | deletes that reminder |
| `event.create` | Event in `SWARMAA_CALENDAR_NAME` (or the first writable calendar). No attendees, nothing is sent | `Event added: Dentist · Tue 1 Dec 10:00–10:30` | deletes the event by uid |
| `timer.start` | A reminder titled `⏱ <label>` due and alerting at fire time. Clock cannot be scripted | `Timer set: Tea · 17:05` | deletes that reminder |
| `note.append` | Appends a block to `<notes dir>/<notebook>/YYYY-MM-DD.md`. The notebook is `inbox` (the default), `daily` or `meetings` | `Noted in Inbox: Buy filters` | removes that block, and the file if it ends up empty |

Every item carries a marker `swarmaa:<action id>`: in the reminder notes, in the event notes, or as `<!-- swarmaa:<id> -->` … `<!-- /swarmaa:<id> -->` around the note. On a retry (any attempt after the first) the runner looks for that marker before creating anything, so a retry after a crash returns the existing item instead of adding a second one. The first attempt of an action skips the lookup, because nothing can exist yet. Before an undo deletes anything, it checks that the item still carries the marker.

A failure shows up as a card, for example `Couldn't set the reminder: Swarmaa needs Reminders access (System Settings › Privacy & Security › Automation)`. The codes are `permission_denied`, `action_disabled`, `timeout` (8 s), `unavailable` (the service is not on macOS; notes still work) and `failed`.

## Owner setup

Environment of the Swarmaa service. Every variable is optional:

| Variable | Default | Meaning |
|---|---|---|
| `SWARMAA_LOCAL_ACTIONS` | `reminders,calendar,notes` | The apps the service may touch, as a comma list. Set it to an empty string to turn all three off. A disabled action returns `action_disabled`, and the memo goes to the Assistant instead. |
| `SWARMAA_REMINDERS_LIST` | the Reminders default list | The list used for reminders and timers. It must already exist, or the action fails with "list not found". |
| `SWARMAA_TODO_LIST` | `SWARMAA_REMINDERS_LIST` | The list used for "todo …" memos. |
| `SWARMAA_CALENDAR_NAME` | first writable calendar | The calendar for new events. |
| `SWARMAA_NOTES_DIR` | `~/.swarmaa/notes` | The notebook root. It must be an absolute path. Each directory is created 0700 and each file 0600. Any symlink in the path is refused, as is a notes directory or file that is not owner-only. Keep it under your home folder: on macOS `/var` and `/tmp` are symlinks, so paths under them are refused. |
| `SWARMAA_TIME_ZONE` | system zone | The IANA zone used for note file dates and for card times of agent and tool actions. Memo cards use the phone's zone sent with the memo. |

The lists and calendars come only from these variables. A transcript can never pick a list, calendar, path, script or binary.

## One-time permission grant (do this at the Mac)

macOS controls Apple Events through TCC (Automation). Someone has to be at the Mac the first time:

1. Start Swarmaa the way it normally runs.
2. Run `local_action_check` once. The check only reads: it counts lists and calendars. macOS then asks "… wants to control Reminders" and "… wants to control Calendar". Click **Allow** for each. The check waits up to 60 s for you to answer. A normal action waits only 8 s, so if the first prompt appears during a spoken action, that action times out.
3. Check the result: every enabled app should report `ok`. `permission_denied` means the grant was refused or never shown. `disabled` means the app is not enabled in `SWARMAA_LOCAL_ACTIONS`, or (for Reminders and Calendar) the service is not running on macOS. For Reminders and Calendar, any failure to reach the app is also reported as `permission_denied`.

To re-enable later, or to revoke access, go to **System Settings › Privacy & Security › Automation**, open the entry that sent the prompt, and switch Reminders or Calendar on. To get a fresh prompt instead, run `tccutil reset AppleEvents` and then run the check again.

**Unverified: which app macOS names in the prompt.** When Swarmaa.app runs the bundled node service, TCC should treat Swarmaa.app as responsible for `osascript`. In that case the prompt names Swarmaa and shows its `NSAppleEventsUsageDescription`, and the grant is listed under Swarmaa. The app has the `com.apple.security.automation.apple-events` entitlement and that string for this purpose, but nobody has confirmed the attribution on a real Mac yet. When the service runs from a LaunchAgent, Terminal or `npm run dev`, the prompt and the Automation entry name that host instead (node, osascript or Terminal). The grant follows that host, so a grant given while testing in Terminal does not carry over to Swarmaa.app.

The first action after login can take 1–3 s longer, because Apple Events launch Reminders or Calendar if they are not running. To hide that, the service pre-launches them at start and whenever the phone sends `voice_warm` (at the ring's idle edge), but only apps that are enabled and whose last check or action in this service run was `ok`. Run `local_action_check` once after each service start if you want the very first memo warm too.

## Safety properties

- `/usr/bin/osascript -l JavaScript -e <fixed script>` runs without a shell. Runs and undos go to one persistent helper (the same script started with the fixed argument `loop`, one JSON request line in and one response line out); if the helper fails for any reason other than a timeout, that request is retried as a one-shot `execFile` run. `local_action_check` is always one-shot. Request JSON goes on stdin in both modes, so transcripts never appear in `ps`. The environment holds only `PATH=/usr/bin:/bin`, so no service tokens reach the subprocess. A request is killed with SIGKILL after 8 s (the helper is then restarted on the next request), output is capped at 64 KiB, at most one run or undo is in flight, and the helper exits after 10 idle minutes.
- The script never calls `eval` or `doShellScript`, and it never builds code from input. All input fields are used only as strings and dates.
- The runner checks each action again before it runs: only known keys are accepted, the title can be at most 200 characters, notes at most 4000 and note text at most 16384, and times must be canonical ISO. Text also passes through `redactSecrets` before it is written anywhere.
- Note text cannot fake or close a marker block, because `<!--` is escaped.
