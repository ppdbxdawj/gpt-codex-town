import AppKit
import ImageIO

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: make-icon.swift <output.png>\n", stderr)
    exit(1)
}

let size = 1024
let output = URL(fileURLWithPath: CommandLine.arguments[1])
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bitmapFormat: .alphaFirst,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else { exit(1) }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let canvas = NSRect(x: 0, y: 0, width: size, height: size)
NSColor(calibratedRed: 0.88, green: 0.82, blue: 0.96, alpha: 1).setFill()
canvas.fill()

let inset = NSRect(x: 72, y: 72, width: 880, height: 880)
let panel = NSBezierPath(roundedRect: inset, xRadius: 230, yRadius: 230)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 1.00, green: 0.83, blue: 0.88, alpha: 1),
    NSColor(calibratedRed: 0.78, green: 0.88, blue: 0.86, alpha: 1)
])!
gradient.draw(in: panel, angle: -45)

NSColor(calibratedWhite: 1, alpha: 0.33).setFill()
NSBezierPath(ovalIn: NSRect(x: 154, y: 660, width: 470, height: 170)).fill()

func star(center: NSPoint, outer: CGFloat, inner: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    for index in 0..<10 {
        let angle = CGFloat.pi / 2 + CGFloat(index) * .pi / 5
        let radius = index.isMultiple(of: 2) ? outer : inner
        let point = NSPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius)
        index == 0 ? path.move(to: point) : path.line(to: point)
    }
    path.close()
    return path
}

let mainStar = star(center: NSPoint(x: 512, y: 488), outer: 255, inner: 113)
NSColor(calibratedRed: 1.00, green: 0.76, blue: 0.25, alpha: 1).setFill()
mainStar.fill()
NSColor(calibratedRed: 0.86, green: 0.52, blue: 0.22, alpha: 0.34).setStroke()
mainStar.lineWidth = 24
mainStar.stroke()

for point in [NSPoint(x: 765, y: 738), NSPoint(x: 270, y: 310), NSPoint(x: 766, y: 270)] {
    let sparkle = star(center: point, outer: 45, inner: 18)
    NSColor(calibratedWhite: 1, alpha: 0.92).setFill()
    sparkle.fill()
}

NSGraphicsContext.restoreGraphicsState()
if output.pathExtension.lowercased() == "icns" {
    guard let image = bitmap.cgImage,
          let destination = CGImageDestinationCreateWithURL(output as CFURL, "com.apple.icns" as CFString, 1, nil) else { exit(1) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { exit(1) }
} else {
    guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
    try png.write(to: output)
}
