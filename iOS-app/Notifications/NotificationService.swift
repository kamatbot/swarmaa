import UserNotifications
import Intents
import UIKit

public final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    public override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        self.bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let bestAttempt = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        let userInfo = request.content.userInfo
        let botId = (userInfo["bot_id"] as? String) ?? (request.content.threadIdentifier.isEmpty ? nil : request.content.threadIdentifier)
        let botName = (userInfo["bot_name"] as? String) ?? (request.content.title.isEmpty ? nil : request.content.title)
        let botAvatar = userInfo["bot_avatar"] as? String
        let botColor = userInfo["bot_color"] as? String

        guard let id = botId, !id.isEmpty, let name = botName, !name.isEmpty else {
            contentHandler(bestAttempt)
            return
        }

        do {
            let avatarImage = renderAvatar(name: name, botId: id, avatarName: botAvatar, colorName: botColor)
            guard let pngData = avatarImage.pngData() else {
                contentHandler(bestAttempt)
                return
            }

            let inImage = INImage(imageData: pngData)
            let handle = INPersonHandle(value: id, type: .unknown)
            var nameComponents = PersonNameComponents()
            nameComponents.nickname = name
            let sender = INPerson(
                personHandle: handle,
                nameComponents: nameComponents,
                displayName: name,
                image: inImage,
                contactIdentifier: nil,
                customIdentifier: id,
                isMe: false,
                suggestionType: .none
            )

            let intent = INSendMessageIntent(
                recipients: nil,
                outgoingMessageType: .outgoingMessageText,
                content: request.content.body,
                speakableGroupName: nil,
                conversationIdentifier: id,
                serviceName: nil,
                sender: sender,
                attachments: nil
            )

            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .incoming
            interaction.donate(completion: nil)

            let updatedContent = try bestAttempt.updating(from: intent)
            contentHandler(updatedContent)
        } catch {
            contentHandler(bestAttempt)
        }
    }

    public override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }

    private func renderAvatar(name: String, botId: String, avatarName: String?, colorName: String?) -> UIImage {
        let seed = (avatarName?.isEmpty == false ? avatarName : botId) ?? name
        let character = mojiCharacter(seed)

        let circleColor: UIColor
        if let hex = botColorHex(colorName) {
            let r = CGFloat((hex >> 16) & 0xFF) / 255.0
            let g = CGFloat((hex >> 8) & 0xFF) / 255.0
            let b = CGFloat(hex & 0xFF) / 255.0
            circleColor = UIColor(red: r, green: g, blue: b, alpha: 1.0)
        } else {
            // Default circle tone (KS.chip)
            circleColor = UIColor(red: 0x18 / 255.0, green: 0x2C / 255.0, blue: 0x4D / 255.0, alpha: 1.0)
        }

        let glyphImage = loadGlyph(character: character)

        let size = CGSize(width: 120, height: 120)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            let rect = CGRect(origin: .zero, size: size)
            circleColor.setFill()
            ctx.cgContext.fillEllipse(in: rect)

            if let glyph = glyphImage {
                let inset = size.width * 0.1
                let glyphRect = rect.insetBy(dx: inset, dy: inset)
                glyph.draw(in: glyphRect)
            } else {
                let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
                let text = words.count > 1 ? String(words[0].prefix(1) + words[1].prefix(1)) : String(name.prefix(2))
                let letters = text.isEmpty ? "?" : text.uppercased()
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: UIFont.monospacedSystemFont(ofSize: size.width * 0.36, weight: .bold),
                    .foregroundColor: UIColor.white
                ]
                let str = NSAttributedString(string: letters, attributes: attrs)
                let strSize = str.size()
                let strRect = CGRect(
                    x: (size.width - strSize.width) / 2,
                    y: (size.height - strSize.height) / 2,
                    width: strSize.width,
                    height: strSize.height
                )
                str.draw(in: strRect)
            }
        }
    }

    private func loadGlyph(character: String) -> UIImage? {
        let bundle = Bundle(for: NotificationService.self)
        if let image = UIImage(named: "moji-" + character, in: bundle, with: nil) {
            return image
        }
        if let image = UIImage(named: "moji-" + character) {
            return image
        }
        if let path = bundle.path(forResource: "moji-" + character, ofType: "png") {
            return UIImage(contentsOfFile: path)
        }
        return nil
    }
}
