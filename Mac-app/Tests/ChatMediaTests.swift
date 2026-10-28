import XCTest
import AppKit
import ImageIO
import UniformTypeIdentifiers
@testable import Codenotch

final class ChatMediaTests: XCTestCase {
    func testMessageAttachmentMetadataAndLegacyMessageDecode() throws {
        let legacy = Data(#"{"id":"m","seq":1,"kind":"text","body":"hello"}"#.utf8)
        XCTAssertTrue(try SwarmaClient.decoder.decode(TeamsMessage.self, from: legacy).attachments.isEmpty)
        let photo = Data(#"{"id":"m","seq":1,"kind":"text","body":"","attachments":[{"id":"a","name":"photo.jpg","media_type":"image/jpeg","byte_length":5,"sha256":"hash"}]}"#.utf8)
        let message = try SwarmaClient.decoder.decode(TeamsMessage.self, from: photo)
        XCTAssertEqual(message.attachments.first?.id, "a")
        XCTAssertEqual(message.attachments.first?.byteLength, 5)
    }
    func testPrepareCreatesBoundedJPEGWithoutSourceMetadata() async throws {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1800, pixelsHigh: 1200, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let input = bitmap.representation(using: .png, properties: [:])!
        let photo = try await ChatPhoto.prepare(data: input, name: "picture.png")
        XCTAssertEqual(photo.name, "picture.jpg")
        XCTAssertLessThanOrEqual(photo.data.count, 160 * 1024)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(photo.data as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertLessThanOrEqual(properties[kCGImagePropertyPixelWidth] as? Int ?? .max, 1600)
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
    }

    func testPrepareRejectsNonImage() async {
        do { _ = try await ChatPhoto.prepare(data: Data("not an image".utf8), name: "bad") ; XCTFail("Expected rejection") }
        catch { XCTAssertNotNil(error) }
    }
}
