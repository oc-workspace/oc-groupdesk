// Local, allowlisted Accessibility reader. No network or key/database access.
import Cocoa
import ApplicationServices

struct CaptureError: Error { let code: String }
func fail(_ code: String) -> CaptureError { CaptureError(code: code) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    attr(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func text(_ element: AXUIElement, _ name: String) -> String? {
    attr(element, name) as? String
}
func resolve(_ root: AXUIElement, _ path: [Int]) throws -> AXUIElement {
    guard path.count <= 20 else { throw fail("layout_unavailable") }
    var value = root
    for index in path {
        let items = children(value)
        guard index >= 0 && index < items.count else { throw fail("layout_unavailable") }
        value = items[index]
    }
    return value
}
func check(_ element: AXUIElement, _ selector: [String: Any]) throws {
    for (key, attribute) in [("role",kAXRoleAttribute),("identifier",kAXIdentifierAttribute),("description",kAXDescriptionAttribute)] {
        if let expected = selector[key] as? String {
            guard text(element, attribute) == expected else { throw fail("layout_unavailable") }
        }
    }
}
func selected(_ root: AXUIElement, _ selector: [String: Any]) throws -> AXUIElement {
    guard let path = selector["path"] as? [Int], selector["role"] is String else { throw fail("invalid_profile") }
    let element = try resolve(root, path)
    try check(element, selector)
    return element
}
func field(_ root: AXUIElement, _ selector: [String: Any]) throws -> String {
    let element = try selected(root, selector)
    guard let name = selector["attribute"] as? String,
          [kAXValueAttribute,kAXTitleAttribute,kAXDescriptionAttribute,kAXIdentifierAttribute].contains(name),
          let value = text(element, name), !value.isEmpty, value.count <= 16000 else { throw fail("identity_unresolved") }
    return value
}
func mainWindow() throws -> (AXUIElement, NSRunningApplication) {
    guard AXIsProcessTrusted() else { throw fail("permission_required") }
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          session[kCGSessionLoginDoneKey as String] as? Bool == true,
          session["CGSSessionScreenIsLocked"] as? Bool != true else { throw fail("login_required") }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat")
    guard apps.count == 1, let app = apps.first, !app.isHidden else { throw fail("login_required") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 3)
    let windows = attr(element, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let mains = windows.filter { ["Weixin","WeChat","微信"].contains(text($0,kAXTitleAttribute) ?? "") }
    guard mains.count == 1, let window = mains.first,
          attr(window,kAXMinimizedAttribute) as? Bool == false,
          attr(window,kAXModalAttribute) as? Bool != true else { throw fail("login_required") }
    guard windows.allSatisfy({ text($0,kAXRoleAttribute) != kAXSheetRole && attr($0,kAXModalAttribute) as? Bool != true }) else { throw fail("desktop_blocked") }
    return (window,app)
}
func tree(_ root: AXUIElement, depth: Int, budget: inout Int, values: Bool) throws -> [String:Any] {
    budget -= 1
    guard depth < 18 && budget >= 0 else { throw fail("layout_too_large") }
    var node: [String:Any] = ["role":text(root,kAXRoleAttribute) ?? "unknown"]
    if let identifier = text(root,kAXIdentifierAttribute) { node["identifier"] = identifier }
    if values {
        for name in [kAXValueAttribute,kAXTitleAttribute,kAXDescriptionAttribute] {
            if let value = text(root,name) { node[name] = String(value.prefix(16000)) }
        }
    }
    if node["role"] as? String != kAXTextFieldRole && node["role"] as? String != kAXTextAreaRole {
        node["children"] = try children(root).map { try tree($0, depth:depth+1, budget:&budget, values:values) }
    }
    return node
}
func snapshot(_ window: AXUIElement, _ profile: [String:Any]) throws -> [String:Any] {
    guard let title = profile["title"] as? String,
          let header = profile["header"] as? [String:Any],
          let account = profile["account"] as? [String:Any],
          let expectedAccount = profile["account_value"] as? String,
          try field(window,account) == expectedAccount,
          try field(window,header) == title,
          let container = profile["container"] as? [String:Any],
          let rowCheck = profile["row"] as? [String:Any],
          let sender = profile["sender"] as? [String:Any],
          let body = profile["body"] as? [String:Any] else { throw fail("chat_not_verified") }
    let list = try selected(window,container)
    var rows: [[String:Any]] = []
    let items = children(list)
    guard items.count <= 600 else { throw fail("layout_too_large") }
    for element in items {
        // A supported layout has exactly one message row per child. Separators
        // are permitted only when their exact role and identifier were calibrated.
        if let skip = profile["separator"] as? [String:Any], skip["identifier"] is String {
            if (try? check(element,skip)) != nil { continue }
        }
        try check(element,rowCheck)
        let display = try field(element,sender)
        let content = try field(element,body)
        var value: [String:Any] = ["sender":display,"content":content]
        if let identifier = profile["message_id"] as? [String:Any] {
            value["ui_id"] = try field(element,identifier)
        }
        if let timestamp = profile["timestamp"] as? [String:Any] {
            value["timestamp"] = try field(element,timestamp)
        }
        rows.append(value)
    }
    guard let scroll = profile["scroll"] as? [String:Any] else { throw fail("scroll_unavailable") }
    let bar = try selected(window,scroll)
    guard let position = attr(bar,kAXValueAttribute) as? Double, position.isFinite,
          position >= 0 && position <= 1 else { throw fail("scroll_unavailable") }
    guard try field(window,header) == title, try field(window,account) == expectedAccount else { throw fail("chat_not_verified") }
    return ["contract":1,"title":title,"rows":rows,"position":position,"at_bottom":position>=0.999,"at_top":position<=0.001]
}
final class ChangeSignal {
    var changed = false
}
func waitForChange(_ window: AXUIElement, app: NSRunningApplication) throws -> Bool {
    let signal = ChangeSignal()
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, _, _, context in
        guard let context else { return }
        Unmanaged<ChangeSignal>.fromOpaque(context).takeUnretainedValue().changed = true
    }
    guard AXObserverCreate(app.processIdentifier, callback, &observer) == .success,
          let observer else { throw fail("observer_unavailable") }
    let context = Unmanaged.passUnretained(signal).toOpaque()
    var registrations = 0
    for event in ["AXChildrenChanged", "AXRowCountChanged", "AXValueChanged", "AXLayoutChanged", "AXFocusedUIElementChanged", "AXWindowCreated"] {
        if AXObserverAddNotification(observer, window, event as CFString, context) == .success {
            registrations += 1
        }
    }
    guard registrations > 0 else { throw fail("observer_unavailable") }
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    defer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode) }
    let deadline = Date().addingTimeInterval(12)
    while !signal.changed && Date() < deadline {
        CFRunLoopRunInMode(.defaultMode, 0.15, true)
    }
    return signal.changed
}
@main struct Capture {
    static func main() {
        do {
            let bytes = FileHandle.standardInput.readDataToEndOfFile()
            guard bytes.count <= 64000,
                  let request = try JSONSerialization.jsonObject(with:bytes) as? [String:Any],
                  let action = request["action"] as? String else { throw fail("invalid_request") }
            if action == "self-test" { print("ready"); return }
            guard request["confirmed_read"] as? Bool == true else { throw fail("permission_required") }
            let (window,app) = try mainWindow()
            let version = app.bundleURL.flatMap { Bundle(url:$0)?.infoDictionary?["CFBundleVersion"] as? String } ?? "unknown"
            guard request["wechat_build"] as? String == version && version != "unknown" else { throw fail("version_changed") }
            var result: [String:Any]
            if action == "watch" {
                guard let profile = request["profile"] as? [String:Any],
                      let header = profile["header"] as? [String:Any],
                      let account = profile["account"] as? [String:Any],
                      let expected = profile["account_value"] as? String,
                      try field(window,header) == profile["title"] as? String,
                      try field(window,account) == expected else { throw fail("chat_not_verified") }
                result = ["contract":1,"changed":try waitForChange(window,app:app)]
            } else if action == "layout" {
                let root = try resolve(window,request["path"] as? [Int] ?? [])
                var budget = 1500
                result = ["contract":1,"tree":try tree(root,depth:0,budget:&budget,values:request["include_values"] as? Bool == true)]
            } else {
                guard let profile = request["profile"] as? [String:Any] else { throw fail("invalid_profile") }
                result = try snapshot(window,profile)
                if action == "scroll" {
                    guard let direction = request["direction"] as? String, ["up","down","bottom"].contains(direction),
                          let selector = profile["scroll"] as? [String:Any] else { throw fail("invalid_request") }
                    let bar = try selected(window,selector)
                    let position = result["position"] as! Double
                    guard let step = profile["scroll_step"] as? Double, step.isFinite,
                          step >= 0.000001 && step <= 0.1 else { throw fail("scroll_unavailable") }
                    let next = direction == "bottom" ? 1 : max(0,min(1,position+(direction == "up" ? -step:step)))
                    var settable = DarwinBoolean(false)
                    guard AXUIElementIsAttributeSettable(bar,kAXValueAttribute as CFString,&settable) == .success,
                          settable.boolValue, AXUIElementSetAttributeValue(bar,kAXValueAttribute as CFString,NSNumber(value:next)) == .success else { throw fail("scroll_unavailable") }
                    result = ["contract":1,"scroll_requested":true]
                } else if action != "snapshot" { throw fail("invalid_request") }
            }
            let data = try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        } catch {
            let code = (error as? CaptureError)?.code ?? "capture_unavailable"
            print("{\"error\":\"\(code)\"}")
            exit(2)
        }
    }
}
