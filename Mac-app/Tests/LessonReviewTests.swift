import XCTest
@testable import Codenotch

/// Lesson review: wire shapes, request bodies, the forbidden message, the
/// cell, and the window model's refresh. No network; the token is made up.
final class LessonReviewTests: XCTestCase {
    private let lessonJSON = """
    {"id":"lesson_1","scope":"project:fitodds","kind":"workflow","title":"Run the seed first",
     "applicability":"When tests fail on empty DB","body":"Seed before testing.","tags":["db","tests"],
     "evidence":[{"session_id":"s-1","turns":[1,2],"summary":"Seed fixed it"}],
     "state":"candidate","source":"distill","flags":["prompt-injection/ignore-previous"],
     "created_at":"2026-10-22T01:00:00Z","reviewed_at":null,"review_reason":null,"superseded_by":null}
    """

    private func tokenFile() throws -> String {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("lesson-\(UUID().uuidString).json").path
        try Data("{\"token\":\"cn_fake\"}".utf8).write(to: URL(fileURLWithPath: path))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        return path
    }

    private final class Stub: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [URLRequest] = []
        var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
        let code: Int, body: String
        init(_ body: String) { code = 200; self.body = body }
        init(_ code: Int, _ body: String) { self.code = code; self.body = body }
        var transport: SwarmaClient.Transport {
            { [self] request in
                lock.lock(); seen.append(request); lock.unlock()
                return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
            }
        }
    }

    private func client(_ stub: Stub) throws -> SwarmaClient {
        let path = try tokenFile()
        return SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path }, transport: stub.transport)
    }

    private func body(_ stub: Stub) throws -> [String: Any] {
        let data = try XCTUnwrap(stub.requests.last?.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: Decoding

    func testDecodesAFullLesson() throws {
        let list = try SwarmaClient.decoder.decode(SwarmaLesson.List.self, from: Data("{\"lessons\":[\(lessonJSON)]}".utf8))
        let lesson = try XCTUnwrap(list.lessons.first)
        XCTAssertEqual(lesson.id, "lesson_1")
        XCTAssertEqual(lesson.scopeLabel, "fitodds")
        XCTAssertEqual(lesson.evidence, [.init(sessionId: "s-1", turns: [1, 2], summary: "Seed fixed it")])
        XCTAssertEqual(lesson.flags, ["prompt-injection/ignore-previous"])
        XCTAssertNotNil(lesson.createdAt)
        XCTAssertNil(lesson.reviewedAt)
        XCTAssertTrue(SwarmaLesson.warning(forFlag: lesson.flags[0]).contains("Possible prompt injection"))
        XCTAssertEqual(SwarmaLesson.warning(forFlag: "too-long"), "too-long")
    }

    func testDecodesAMinimalLesson() throws {
        let lesson = try SwarmaClient.decoder.decode(SwarmaLesson.self, from: Data(#"{"id":"lesson_2"}"#.utf8))
        XCTAssertEqual(lesson.title, "")
        XCTAssertEqual(lesson.tags, [])
        XCTAssertEqual(lesson.evidence, [])
        XCTAssertEqual(lesson.flags, [])
        XCTAssertEqual(lesson.state, "candidate")
    }

    func testReviewResponseDecodes() throws {
        let reviewed = try SwarmaClient.decoder.decode(SwarmaLesson.Reviewed.self,
                                                       from: Data("{\"lesson\":\(lessonJSON)}".utf8))
        XCTAssertEqual(reviewed.lesson.id, "lesson_1")
    }

    func testLessonsPendingWithAndWithout() throws {
        let with = try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(#"{"lessons_pending":3}"#.utf8))
        let without = try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data("{}".utf8))
        let junk = try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(#"{"lessons_pending":"x"}"#.utf8))
        XCTAssertEqual(with.lessonsPending, 3)
        XCTAssertEqual(without.lessonsPending, 0)
        XCTAssertEqual(junk.lessonsPending, 0)
    }

    func testCitedTurnsAreOneBasedAndSkipOutOfRange() {
        let session = SwarmaSessionDetail(id: "s", turns: [.init(role: "user", text: "a"), .init(role: "assistant", text: "b")])
        XCTAssertEqual(session.cited([2, 5, 0, 1]).map(\.index), [2, 1])
        XCTAssertEqual(session.cited([2, 1]).map(\.turn.text), ["b", "a"])
    }

    // MARK: Requests

    func testListRequestBody() async throws {
        let stub = Stub(#"{"result":{"lessons":[]}}"#)
        _ = try await client(stub).lessons()
        XCTAssertEqual(stub.requests.last?.url?.path, "/api/tools/lesson_list")
        XCTAssertEqual(stub.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer cn_fake")
        let json = try body(stub)
        XCTAssertEqual(json["state"] as? String, "candidate")
        XCTAssertEqual(json["limit"] as? Int, 50)
        XCTAssertEqual(Set(json.keys), ["state", "limit"])
    }

    func testApproveWithoutEditsSendsOnlyIdAndAction() async throws {
        let stub = Stub("{\"result\":{\"lesson\":\(lessonJSON)}}")
        _ = try await client(stub).review(id: "lesson_1", action: .approve)
        XCTAssertEqual(stub.requests.last?.url?.path, "/api/tools/lesson_review")
        let json = try body(stub)
        XCTAssertEqual(Set(json.keys), ["id", "action"])
        XCTAssertEqual(json["action"] as? String, "approve")
    }

    func testEditsAreSentOnlyForChangedFields() async throws {
        let stub = Stub("{\"result\":{\"lesson\":\(lessonJSON)}}")
        _ = try await client(stub).review(id: "lesson_1", action: .approve, edits: .init(title: "New"))
        let edits = try XCTUnwrap(try body(stub)["edits"] as? [String: Any])
        XCTAssertEqual(Set(edits.keys), ["title"])
        XCTAssertEqual(edits["title"] as? String, "New")

        _ = try await client(stub).review(id: "lesson_1", action: .approve, edits: .init())
        XCTAssertNil(try body(stub)["edits"], "an empty edit is no edit")
    }

    func testRejectCarriesTheReasonOnlyWhenGiven() async throws {
        let stub = Stub("{\"result\":{\"lesson\":\(lessonJSON)}}")
        let c = try client(stub)
        _ = try await c.review(id: "lesson_1", action: .reject, reason: "stale")
        XCTAssertEqual(try body(stub)["reason"] as? String, "stale")
        _ = try await c.review(id: "lesson_1", action: .reject, reason: "")
        XCTAssertNil(try body(stub)["reason"])
    }

    func testSessionGetRequestAndDecode() async throws {
        let stub = Stub(#"{"result":{"session":{"id":"s-1","harness":"codex","title":"T","turns":[{"role":"user","text":"hi","at":"x"}]}}}"#)
        let session = try await client(stub).session(id: "s-1")
        XCTAssertEqual(try body(stub)["id"] as? String, "s-1")
        XCTAssertEqual(session.turns.first?.text, "hi")
    }

    func test403MapsToTheClearMessage() async throws {
        let stub = Stub(403, #"{"error":{"code":"forbidden","message":"no"}}"#)
        do { _ = try await client(stub).review(id: "x", action: .approve); XCTFail("expected a failure") }
        catch {
            XCTAssertEqual(error as? SwarmaClient.Failure, .forbidden)
            XCTAssertEqual(LessonReviewModel.describe(error), "This Mac's Swarmaa connection can't review lessons yet")
        }
    }

    // MARK: Cell

    func testLessonsCell() throws {
        let cell = SwarmaCells.lessonsSnapshot(pending: 3)
        XCTAssertEqual(cell.id, "swarm:lessons")
        XCTAssertEqual(cell.displayName, "Lessons")
        XCTAssertEqual(cell.headline?.usedText, "3 to review")
        XCTAssertEqual(cell.headline?.bandOverride, .watch)
        XCTAssertEqual(cell.kind, .swarm)
    }

    func testDirectoryShowsTheLessonsCellOnlyWhileLessonsWait() throws {
        let client = SwarmaClient(serviceURL: { "http://127.0.0.1:1" }, tokenPath: { "" },
                                  transport: { _ in throw URLError(.cannotConnectToHost) })
        XCTAssertFalse(SwarmaDirectory.providers(for: SwarmaStatus(), client: client).map(\.id).contains("swarm:lessons"))
        XCTAssertTrue(SwarmaDirectory.providers(for: SwarmaStatus(lessonsPending: 2), client: client).map(\.id).contains("swarm:lessons"))
    }

    func testLessonsProviderReadsThePendingCount() async throws {
        let stub = Stub(#"{"result":{"lessons_pending":4}}"#)
        let cell = try await SwarmLessonsProvider(client: client(stub)).fetchSnapshot()
        XCTAssertEqual(cell.headline?.usedText, "4 to review")
    }

    // MARK: Window model

    private final class FakeService: LessonService, @unchecked Sendable {
        private let lock = NSLock()
        private var queue: [SwarmaLesson]
        private(set) var reviews: [(String, SwarmaLesson.Action, String?, SwarmaLesson.Edits?)] = []
        var failure: Error?
        init(_ lessons: [SwarmaLesson]) { queue = lessons }
        func lessons(limit: Int) async throws -> [SwarmaLesson] { lock.lock(); defer { lock.unlock() }; return queue }
        func review(id: String, action: SwarmaLesson.Action, reason: String?, edits: SwarmaLesson.Edits?) async throws -> SwarmaLesson {
            if let failure { throw failure }
            lock.lock(); defer { lock.unlock() }
            reviews.append((id, action, reason, edits))
            queue.removeAll { $0.id == id }
            return SwarmaLesson(id: id)
        }
        func session(id: String) async throws -> SwarmaSessionDetail { SwarmaSessionDetail(id: id) }
    }

    @MainActor
    func testApprovalRefreshesTheListAndTellsTheNotch() async throws {
        let service = FakeService([SwarmaLesson(id: "a", title: "A"), SwarmaLesson(id: "b", title: "B")])
        var changed = 0
        let model = LessonReviewModel(service: service) { changed += 1 }
        await model.refresh()
        XCTAssertEqual(model.selectedID, "a")

        await model.approve()
        XCTAssertEqual(model.lessons.map(\.id), ["b"])
        XCTAssertEqual(model.selectedID, "b")
        XCTAssertEqual(changed, 1)
        XCTAssertNil(service.reviews[0].3, "no edits unless the reviewer changed something")

        await model.reject(reason: "stale")
        XCTAssertTrue(model.lessons.isEmpty)
        XCTAssertNil(model.selectedID)
        XCTAssertEqual(service.reviews[1].1, .reject)
        XCTAssertEqual(service.reviews[1].2, "stale")
        XCTAssertEqual(changed, 2)
    }

    @MainActor
    func testEditedFieldsOnlyGoOut() async throws {
        let service = FakeService([SwarmaLesson(id: "a", title: "A", applicability: "When x", body: "Body")])
        let model = LessonReviewModel(service: service)
        await model.refresh()
        model.isEditing = true
        model.title = "A2"
        XCTAssertEqual(model.edits, .init(title: "A2"))
        await model.approve()
        XCTAssertEqual(service.reviews[0].3, .init(title: "A2"))
    }

    @MainActor
    func testForbiddenIsShownAndNothingChanges() async throws {
        let service = FakeService([SwarmaLesson(id: "a")])
        let model = LessonReviewModel(service: service)
        await model.refresh()
        service.failure = SwarmaClient.Failure.forbidden
        await model.approve()
        XCTAssertEqual(model.message, "This Mac's Swarmaa connection can't review lessons yet")
        XCTAssertEqual(model.lessons.count, 1)
    }
}
