import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var status: NSTextField!
    private var server: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var startupBuffer = Data()
    private var origin: URL?
    private var terminating = false
    private var timeout: Timer?
    private var demo: Bool { Bundle.main.object(forInfoDictionaryKey: "TgdeckDemoMode") as? Bool == true || CommandLine.arguments.contains("--demo") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        let configuration = WKWebViewConfiguration()
        // Session credentials and rendered account content are memory-only.
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = demo ? "tgdeck — Demo" : "tgdeck"
        window.minSize = NSSize(width: 440, height: 540)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.setFrameAutosaveName("tgdeck-board")
        window.center()
        status = NSTextField(wrappingLabelWithString: "Opening your workspace…")
        status.alignment = .center
        status.font = .systemFont(ofSize: 17)
        status.textColor = .secondaryLabelColor
        status.translatesAutoresizingMaskIntoConstraints = false
        webView.addSubview(status)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: webView.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: webView.centerYAnchor),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 420)
        ])
        showWindow()
        startServer()
    }

    private func makeMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About tgdeck", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide tgdeck", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit tgdeck", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        main.addItem(editItem)
        let windowItem = NSMenuItem()
        let windows = NSMenu(title: "Window")
        let show = windows.addItem(withTitle: "Show Board", action: #selector(showWindow), keyEquivalent: "1")
        show.target = self
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windows
        main.addItem(windowItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows
    }

    @objc private func showWindow() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    private func fail(_ message: String) {
        timeout?.invalidate()
        status.stringValue = message
        status.isHidden = false
        webView.isHidden = false
    }

    private func startServer() {
        guard let resources = Bundle.main.resourceURL else { fail("The app is incomplete. Rebuild tgdeck and try again."); return }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("runtime/node")
        process.arguments = [resources.appendingPathComponent("app/src/desktop.ts").path]
        if demo { process.arguments?.append("--demo") }
        process.currentDirectoryURL = resources.appendingPathComponent("app")
        // Do not inherit NODE_OPTIONS, DEBUG, DYLD overrides or data-directory
        // overrides from a shell. There is no shell command interpolation.
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(),
                               "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        let incoming = Pipe()
        let outgoing = Pipe()
        input = incoming
        output = outgoing
        process.standardInput = incoming
        process.standardOutput = outgoing
        process.standardError = FileHandle.nullDevice
        server = process
        outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.receive(data) }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.timeout?.invalidate()
                if self.terminating { NSApp.reply(toApplicationShouldTerminate: true) }
                else if self.origin != nil { self.fail("The local service stopped. Quit and reopen tgdeck to reconnect.") }
            }
        }
        do {
            try process.run()
            // Close the parent's unused pipe ends, so EOF tracks app lifetime.
            incoming.fileHandleForReading.closeFile()
            outgoing.fileHandleForWriting.closeFile()
            timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                guard let self = self, self.origin == nil else { return }
                self.fail("The local service could not start. Quit and reopen tgdeck.")
                self.server?.terminate()
            }
        } catch { fail("The bundled service could not start. Rebuild tgdeck and try again.") }
    }

    private func receive(_ data: Data) {
        guard origin == nil, !terminating else { return }
        startupBuffer.append(data)
        guard startupBuffer.count <= 8192 else { server?.terminate(); fail("The local service returned an invalid response."); return }
        guard let newline = startupBuffer.firstIndex(of: 10) else { return }
        let line = startupBuffer.prefix(upTo: newline)
        startupBuffer.removeSubrange(...newline)
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: String] else { return }
        if message["type"] == "error" {
            fail(message["code"] == "alreadyRunning"
                ? "tgdeck is already running in a terminal, or port 4310 is busy. Stop that instance, then quit and reopen this app."
                : "Could not open the local workspace. Check that the app can access its Application Support folder, then reopen it.")
            return
        }
        guard message["type"] == "ready", let value = message["url"], let url = URL(string: value),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0,
              url.path == "/", url.user == nil, url.password == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.queryItems?.count == 1, let item = components.queryItems?.first,
              item.name == "token", let token = item.value,
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            server?.terminate(); fail("The local service returned an invalid startup link."); return
        }
        timeout?.invalidate()
        origin = URL(string: "http://127.0.0.1:\(port)")
        startupBuffer.removeAll(keepingCapacity: false)
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let local = url.scheme == origin?.scheme && url.host == origin?.host && url.port == origin?.port && url.user == nil && url.password == nil
        if local && action.targetFrame?.isMainFrame == true { decisionHandler(.allow); return }
        // External pages never enter the account's web view. Only an explicit
        // link click may open an http(s) or Telegram link in its default app.
        if action.navigationType == .linkActivated, let scheme = url.scheme?.lowercased(),
           ["https", "http", "tg"].contains(scheme), !local { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { status.isHidden = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("Could not open the workspace. Quit and reopen tgdeck to reconnect.") }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server = server, server.isRunning else { return .terminateNow }
        if terminating { return .terminateLater }
        terminating = true
        timeout?.invalidate()
        input?.fileHandleForWriting.closeFile()
        server.terminate()
        // A hung native client must not leave the app stuck at logout.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.terminating, server.isRunning else { return }
            kill(server.processIdentifier, SIGKILL)
        }
        return .terminateLater
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
