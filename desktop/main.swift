import Cocoa
import WebKit
import UserNotifications

// The app owns its renderer and a pipe-connected local reader. No HTTP server.
final class LocalAssets: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root.resolvingSymlinksInPath() }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else {
            task.didFailWithError(NSError(domain: "Manor", code: 404)); return
        }
        let path = url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: "Manor", code: 404)); return
        }
        let types = ["html":"text/html", "js":"application/javascript", "css":"text/css", "json":"application/json", "png":"image/png", "webp":"image/webp", "svg":"image/svg+xml", "glb":"model/gltf-binary", "fbx":"application/octet-stream"]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": types[file.pathExtension] ?? "application/octet-stream",
            "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*"
        ])!
        task.didReceive(response); task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class LocalReader {
    var process: Process?
    var input: FileHandle?
    var pending: [String: (Result<Any, Error>) -> Void] = [:]
    var buffer = Data()
    var sequence = 0
    let resources: URL
    init(resources: URL) { self.resources = resources }
    func start() throws {
        if process?.isRunning == true { return }
        let child = Process(), incoming = Pipe(), outgoing = Pipe()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        child.arguments = ["-u", resources.appendingPathComponent("service/desktop_service.py").path]
        child.currentDirectoryURL = resources.appendingPathComponent("service")
        var env = ProcessInfo.processInfo.environment
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        child.environment = env
        child.standardInput = incoming; child.standardOutput = outgoing
        child.standardError = FileHandle.standardError
        outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            DispatchQueue.main.async { self?.consume(chunk) }
        }
        child.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let callbacks = self.pending.values; self.pending.removeAll()
                callbacks.forEach { $0(.failure(NSError(domain: "Manor", code: 1, userInfo: [NSLocalizedDescriptionKey:"本机记录暂时无法读取，请稍后重试。"]))) }
            }
        }
        try child.run(); process = child; input = incoming.fileHandleForWriting
    }
    func request(_ method: String, _ params: [String:Any] = [:], completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            try start(); sequence += 1; let id = "native-\(sequence)"
            let data = try JSONSerialization.data(withJSONObject: ["id":id,"method":method,"params":params])
            pending[id] = completion
            try input?.write(contentsOf: data + Data([10]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                if let callback = self?.pending.removeValue(forKey: id) {
                    callback(.failure(NSError(domain: "Manor", code: 2, userInfo: [NSLocalizedDescriptionKey:"读取用时较长，请稍后重试。"])))
                }
            }
        } catch { completion(.failure(error)) }
    }
    func consume(_ chunk: Data) {
        buffer.append(chunk)
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer[..<end]; buffer.removeSubrange(...end)
            guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String:Any],
                  let id = message["id"] as? String, let callback = pending.removeValue(forKey: id) else { continue }
            if let error = message["error"] as? [String:Any] {
                callback(.failure(NSError(domain:"Manor",code:3,userInfo:[NSLocalizedDescriptionKey:error["message"] as? String ?? "操作未完成。"])))
            } else { callback(.success(message["result"] ?? NSNull())) }
        }
    }
    func stop() { input?.closeFile(); if process?.isRunning == true { process?.terminate() }; process = nil }
}

final class ManorApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var reader: LocalReader!
    var statusItem: NSStatusItem!
    var timer: Timer?
    var mode = "mini"
    var pendingCount = 0
    var seenResults: Set<String>?
    var loaded = false
    var nativePollBusy = false
    var topItem: NSMenuItem!
    var notificationItem: NSMenuItem!
    let launchDate = Date()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Launch Services normally enforces one instance; direct executable launches do too.
        if let id = Bundle.main.bundleIdentifier,
           let other = NSRunningApplication.runningApplications(withBundleIdentifier:id).first(where:{$0.processIdentifier != getpid()}) {
            other.activate(options:.activateAllWindows); NSApp.terminate(nil); return
        }
        guard let resources = Bundle.main.resourceURL else { NSApp.terminate(nil); return }
        reader = LocalReader(resources:resources)
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(LocalAssets(root:resources.appendingPathComponent("public")), forURLScheme:"manor")
        configuration.userContentController.add(self, name:"manor")
        configuration.userContentController.addUserScript(WKUserScript(source: bridgeScript, injectionTime:.atDocumentStart, forMainFrameOnly:true))
        web = WKWebView(frame:.zero, configuration:configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.setValue(false, forKey:"drawsBackground")
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:430,height:440),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title = "星糖庄园"; window.minSize = NSSize(width:390,height:420)
        window.contentView = web; window.delegate = self; window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(calibratedRed:0.98,green:0.95,blue:0.97,alpha:1)
        window.center(); makeMenus()
        UNUserNotificationCenter.current().delegate = self
        web.load(URLRequest(url:URL(string:"manor://app/index.html")!))
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
        timer = Timer.scheduledTimer(withTimeInterval:15,repeats:true) { [weak self] _ in self?.poll() }
        poll()
    }
    let bridgeScript = """
    (() => {
      const waiting = new Map(); let sequence = 0;
      window.manorDesktop = Object.freeze({
        request(method, params = {}) {
          const id = 'js-' + (++sequence);
          return new Promise((resolve,reject) => {
            const timer = setTimeout(() => { waiting.delete(id); reject(new Error('本机连接暂时繁忙，请重试。')); },30000);
            waiting.set(id,{resolve,reject,timer});
            window.webkit.messageHandlers.manor.postMessage({id,method,params});
          });
        },
        receive(message) {
          const p = waiting.get(message.id); if (!p) return;
          clearTimeout(p.timer); waiting.delete(message.id);
          message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
        }
      });
      document.addEventListener('DOMContentLoaded',() => { document.documentElement.dataset.desktopMode = 'mini'; });
      window.addEventListener('error', event => {
        window.webkit.messageHandlers.manor.postMessage({id:'diagnostic',method:'diagnostic',params:{message:String(event.message || 'Resource load error')}});
      });
    })();
    """
    func script(_ source: String) { web?.evaluateJavaScript(source,completionHandler:nil) }
    func reply(_ id: String, result: Any? = nil, error: String? = nil) {
        let message: [String:Any] = error == nil ? ["id":id,"result":result ?? NSNull()] : ["id":id,"error":error!]
        guard let data = try? JSONSerialization.data(withJSONObject:message), let json = String(data:data,encoding:.utf8) else { return }
        script("window.manorDesktop.receive(\(json))")
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, web.url?.scheme == "manor", web.url?.host == "app",
              let body = message.body as? [String:Any], let id = body["id"] as? String,
              let method = body["method"] as? String else { return }
        let params = body["params"] as? [String:Any] ?? [:]
        switch method {
        case "diagnostic":
            let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/StarSugarManor")
            try? FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
            let file = folder.appendingPathComponent("desktop.log")
            let line = "\(Date()): \(String((params["message"] as? String ?? "").prefix(2000)))\n"
            if !FileManager.default.fileExists(atPath:file.path) { FileManager.default.createFile(atPath:file.path,contents:nil) }
            if let handle = try? FileHandle(forWritingTo:file) { try? handle.seekToEnd(); try? handle.write(contentsOf:Data(line.utf8)); try? handle.close() }
        case "state", "mark_read", "accept", "reopen":
            reader.request(method,params) { [weak self] response in
                guard let self = self else { return }
                switch response {
                case .success(let value): self.observe(value); self.reply(id,result:value)
                case .failure(let error): self.reply(id,error:error.localizedDescription)
                }
            }
        case "window":
            setMode(params["mode"] as? String == "full" ? "full" : "mini"); reply(id,result:["mode":mode])
        case "badge": reply(id,result:["ok":true]) // Counts are derived from the reader, never from rendered text.
        case "open_url":
            if let raw = params["url"] as? String, let url = URL(string:raw), ["https","codex"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url); reply(id,result:["ok":true])
            } else { reply(id,error:"这个入口暂时无法打开。") }
        case "open_artifact":
            reader.request("artifact_path",params) { [weak self] response in
                switch response {
                case .success(let value):
                    if let path = (value as? [String:Any])?["path"] as? String {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath:path)]); self?.reply(id,result:["ok":true])
                    } else { self?.reply(id,error:"文件暂时不可用。") }
                case .failure(let error): self?.reply(id,error:error.localizedDescription)
                }
            }
        case "clipboard":
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(params["text"] as? String ?? "",forType:.string); reply(id,result:["ok":true])
        default: reply(id,error:"暂不支持此操作。")
        }
    }
    func setMode(_ newMode: String) {
        mode = newMode; let old = window.frame
        window.minSize = mode == "mini" ? NSSize(width:390,height:420) : NSSize(width:920,height:650)
        let size = mode == "mini" ? NSSize(width:430,height:440) : NSSize(width:1260,height:820)
        let available = window.screen?.visibleFrame ?? NSScreen.main!.visibleFrame
        var frame = NSRect(x:old.midX-size.width/2,y:old.maxY-size.height,width:min(size.width,available.width),height:min(size.height,available.height))
        frame.origin.x = max(available.minX,min(frame.minX,available.maxX-frame.width))
        frame.origin.y = max(available.minY,min(frame.minY,available.maxY-frame.height))
        window.setFrame(frame,display:true,animate:true)
        script("document.documentElement.dataset.desktopMode='\(mode)';window.dispatchEvent(new CustomEvent('manor-desktop-mode',{detail:{mode:'\(mode)'}}))")
        showWindow()
    }
    @objc func expand() { setMode("full") }
    @objc func compact() { setMode("mini") }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true); visibility() }
    @objc func hideWindow() { window.orderOut(nil); visibility() }
    @objc func inbox() { expand(); script("window.dispatchEvent(new CustomEvent('manor-open-inbox'))") }
    @objc func toggleTop() { let pinned = window.level != .floating; window.level = pinned ? .floating : .normal; topItem.state = pinned ? .on : .off }
    @objc func allowNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound]) { granted,_ in
            DispatchQueue.main.async {
                UserDefaults.standard.set(granted,forKey:"manor-notifications")
                self.notificationItem.state = granted ? .on : .off
            }
        }
    }
    @objc func quit() { NSApp.terminate(nil) }
    func makeMenus() {
        let menu = NSMenu(), appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle:"显示星糖庄园",action:#selector(showWindow),keyEquivalent:"0").target = self
        appMenu.addItem(.separator()); appMenu.addItem(withTitle:"退出星糖庄园",action:#selector(quit),keyEquivalent:"q").target = self
        let edit = NSMenuItem(title:"编辑",action:nil,keyEquivalent:""); let editMenu = NSMenu(title:"编辑"); edit.submenu = editMenu; menu.addItem(edit)
        editMenu.addItem(withTitle:"复制",action:#selector(NSText.copy(_:)),keyEquivalent:"c")
        editMenu.addItem(withTitle:"粘贴",action:#selector(NSText.paste(_:)),keyEquivalent:"v")
        editMenu.addItem(withTitle:"全选",action:#selector(NSText.selectAll(_:)),keyEquivalent:"a")
        NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength)
        statusItem.button?.title = "✦"; statusItem.button?.toolTip = "星糖庄园"
        let tray = NSMenu()
        for (title,action) in [("展开庄园",#selector(expand)),("迷你庄园",#selector(compact)),("查看待拆礼盒",#selector(inbox)),("收起到菜单栏",#selector(hideWindow))] {
            tray.addItem(withTitle:title,action:action,keyEquivalent:"").target = self
        }
        tray.addItem(.separator())
        topItem = tray.addItem(withTitle:"窗口置顶",action:#selector(toggleTop),keyEquivalent:""); topItem.target = self
        notificationItem = tray.addItem(withTitle:"允许新成果提醒…",action:#selector(allowNotifications),keyEquivalent:""); notificationItem.target = self
        notificationItem.state = UserDefaults.standard.bool(forKey:"manor-notifications") ? .on : .off
        tray.addItem(.separator()); tray.addItem(withTitle:"退出星糖庄园",action:#selector(quit),keyEquivalent:"q").target = self
        statusItem.menu = tray
    }
    func poll() {
        guard !nativePollBusy else { return }; nativePollBusy = true
        reader.request("state") { [weak self] result in
            self?.nativePollBusy = false
            if case .success(let value) = result { self?.observe(value) }
        }
    }
    func observe(_ value: Any) {
        guard let state = value as? [String:Any], let inbox = state["inbox"] as? [String:Any] else { return }
        pendingCount = inbox["pendingCount"] as? Int ?? 0
        statusItem?.button?.title = pendingCount > 0 ? "✦ \(pendingCount)" : "✦"
        statusItem?.button?.toolTip = "星糖庄园 · \(pendingCount) 份成果待验收"
        NSApp.dockTile.badgeLabel = pendingCount > 0 ? String(pendingCount) : nil
        let items = inbox["items"] as? [[String:Any]] ?? []
        let ids = Set(items.compactMap{$0["id"] as? String})
        if let seen = seenResults, UserDefaults.standard.bool(forKey:"manor-notifications") {
            let newItems = items.filter { item in
                guard let id = item["id"] as? String, !seen.contains(id), let raw = item["createdAt"] as? String else { return false }
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
                let date = formatter.date(from:raw) ?? ISO8601DateFormatter().date(from:raw) ?? .distantPast
                return date > launchDate
            }
            if !newItems.isEmpty {
                let content = UNMutableNotificationContent(); content.title = "庄园收到新礼盒"
                content.body = "有 \(newItems.count) 份新成果等你查看。"; content.sound = .default
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier:UUID().uuidString,content:content,trigger:nil))
            }
        }
        seenResults = (seenResults ?? []).union(ids)
    }
    func visibility() {
        guard loaded else { return }
        let visible = window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
        script("window.dispatchEvent(new CustomEvent('manor-visibility',{detail:{visible:\(visible)}}))")
    }
    func windowDidChangeOcclusionState(_ notification: Notification) { visibility() }
    func windowDidMiniaturize(_ notification: Notification) { visibility() }
    func windowDidDeminiaturize(_ notification: Notification) { visibility() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hideWindow(); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); reader?.stop() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true; script("document.documentElement.dataset.desktopMode='\(mode)';window.dispatchEvent(new CustomEvent('manor-desktop-mode',{detail:{mode:'\(mode)'}}))"); visibility()
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "manor" && url.host == "app" { decisionHandler(.allow) }
        else { if action.navigationType == .linkActivated && ["https","codex"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["https","codex"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; return nil
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completion: @escaping () -> Void) { DispatchQueue.main.async { self.inbox() }; completion() }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) { completion([.banner,.sound]) }
}

let application = NSApplication.shared
let delegate = ManorApp()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
