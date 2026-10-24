import AppKit

// Geometry-only artwork; no account images or machine-specific resources.
let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: 1024, height: 1024))
        image.lockFocus()
        NSColor(calibratedRed: 0.08, green: 0.13, blue: 0.11, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 204, yRadius: 204).fill()
        for (index, height) in [410.0, 590.0, 480.0].enumerated() {
            NSColor(calibratedRed: 0.64, green: 0.78, blue: 0.55, alpha: index == 1 ? 1 : 0.65).setFill()
            NSBezierPath(roundedRect: NSRect(x: 200 + Double(index) * 220, y: 212, width: 174, height: height), xRadius: 48, yRadius: 48).fill()
            NSColor(calibratedWhite: 0.95, alpha: 0.5).setFill()
            NSBezierPath(roundedRect: NSRect(x: 230 + Double(index) * 220, y: height + 142, width: 114, height: 12), xRadius: 6, yRadius: 6).fill()
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
