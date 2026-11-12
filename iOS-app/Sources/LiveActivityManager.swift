import ActivityKit
import Foundation

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private var startTokenTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    private var trackedActivityIDs = Set<String>()

    private init() {}

    func start(model: AppModel) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // 1. Observe push-to-start token updates
        startTokenTask?.cancel()
        startTokenTask = Task { [weak model] in
            for await tokenData in Activity<BotTurnAttributes>.pushToStartTokenUpdates {
                guard !Task.isCancelled else { break }
                await model?.registerActivityStartToken(tokenData)
            }
        }

        // 2. Observe active activities and their per-activity push tokens
        activityUpdatesTask?.cancel()
        activityUpdatesTask = Task { [weak self, weak model] in
            // Observe existing activities
            for activity in Activity<BotTurnAttributes>.activities {
                self?.track(activity: activity, model: model)
            }

            // Observe new activities
            for await activity in Activity<BotTurnAttributes>.activityUpdates {
                guard !Task.isCancelled else { break }
                self?.track(activity: activity, model: model)
            }
        }
    }

    private func track(activity: Activity<BotTurnAttributes>, model: AppModel?) {
        let id = activity.id
        guard trackedActivityIDs.insert(id).inserted else { return }

        let botId = activity.attributes.botId

        if let existingToken = activity.pushToken {
            Task { [weak model] in
                await model?.registerActivityToken(existingToken, botId: botId)
            }
        }

        Task { [weak self, weak model] in
            for await tokenData in activity.pushTokenUpdates {
                guard !Task.isCancelled else { break }
                await model?.registerActivityToken(tokenData, botId: botId)
            }
            // Once the activity updates sequence finishes (activity ended), allow cleanup if needed
            self?.trackedActivityIDs.remove(id)
        }
    }
}
