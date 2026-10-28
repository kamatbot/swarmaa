import Foundation

/// The text a new user pastes into Claude Code, Codex or Antigravity after setup, so the agent knows the swarm exists
/// and how to use it. Pure, so it can be tested without a window.
enum StarterPrompt {
    /// `remoteMCP`: the gateway's MCP URL when this Mac only connected to a remote Swarmaa, so its agents still need the server added.
    static func text(projects: [String], remoteMCP: String? = nil) -> String {
        let scopes = projects.isEmpty ? "project:general" : projects.joined(separator: ", ")
        let add = remoteMCP.map { "\n\nIf you don't have the MCP server \"swarma\" yet, help me add it as a remote MCP server at \($0) " +
            "(Claude Code: claude mcp add --transport http swarma \($0)); I'll approve the sign-in in my browser." } ?? ""
        return """
        You are connected to Swarmaa, a shared memory and task queue for my AI coding agents. It is available to you \
        as the MCP server "swarma".\(add)

        How to use it:
        1. Call swarm_status first: it shows which workers (Claude, Codex, Antigravity) are live, their free slots and quota left.
        2. My projects: \(scopes). Before working in one, call context_get for it; save lasting facts and decisions with memory_propose.
        3. When I ask for work that can run in parallel, split it into independent tasks and submit them together with \
        task_submit: required_capability "auto.read" for research or review, "auto.patch" for code changes. Swarmaa routes \
        each task to the agent with the most quota. Patches land on their own local git branch; nothing is pushed.
        4. Tell me the "Swarm started" message you get back, then give me short updates as tasks finish (task_get or events_poll).

        Start now: call swarm_status and tell me in two lines what is available.
        """
    }
}
