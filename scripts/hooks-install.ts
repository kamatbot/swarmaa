// Contract stub: replaced by the chat-journal implementation.
export type Harness = 'claude' | 'codex' | 'agy';
export interface HookResult { harness: Harness; changed: string[]; skipped?: string }

/** Installs (idempotently) the hook that records this harness's chats into Swarmaa. */
export async function installJournalHooks(harness: Harness, opts: { root: string; dry: boolean; log: (line: string) => void }): Promise<HookResult> {
  void opts; throw new Error(`journal hooks for ${harness} are not implemented yet`);
}

/** Removes the hook installJournalHooks added, leaving every other hook untouched. */
export async function removeJournalHooks(harness: Harness, opts: { root: string; dry: boolean; log: (line: string) => void }): Promise<HookResult> {
  void opts; throw new Error(`journal hooks for ${harness} are not implemented yet`);
}
