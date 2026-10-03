import AppKit
import Foundation

// Package the approved artwork without redrawing or recoloring it.
// Run from the project root: npm run icons:mac
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("public/assets/noah/logo.png")
let output = root.appendingPathComponent("desktop/assets", isDirectory: true)
guard let artwork = NSImage(contentsOf: source), artwork.size.width > 0, artwork.size.height > 0 else {
    fatalError("Cannot read the approved Noah logo at \(source.path)")
}
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let size = 1024
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: size * 4, bitsPerPixel: 32
), let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Cannot create the icon bitmap")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
graphics.imageInterpolation = .high
let context = graphics.cgContext
context.setShouldAntialias(true)
context.clear(CGRect(x: 0, y: 0, width: size, height: size))

let tile = NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864),
                        xRadius: 194, yRadius: 194)
// A neutral macOS tile keeps the approved colors legible in the Dock.
NSColor.white.setFill()
tile.fill()
NSColor(calibratedWhite: 0.90, alpha: 1).setStroke()
tile.lineWidth = 1
tile.stroke()

let scale = 800 / max(artwork.size.width, artwork.size.height)
let width = artwork.size.width * scale
let height = artwork.size.height * scale
artwork.draw(in: NSRect(x: (1024 - width) / 2, y: (1024 - height) / 2,
                       width: width, height: height),
             from: .zero, operation: .sourceOver, fraction: 1,
             respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode the icon PNG")
}
try png.write(to: output.appendingPathComponent("icon.png"), options: .atomic)
print("Created desktop/assets/icon.png (1024 × 1024)")

func run(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        throw NSError(domain: "NoahIcon", code: Int(process.terminationStatus),
                      userInfo: [NSLocalizedDescriptionKey: "Icon generation command failed: \(executable)"])
    }
}

let iconset = output.appendingPathComponent("icon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for logicalSize in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        let pixels = String(logicalSize * scale)
        let filename = "icon_\(logicalSize)x\(logicalSize)\(suffix).png"
        try run("/usr/bin/sips", ["-z", pixels, pixels, output.appendingPathComponent("icon.png").path,
                                   "--out", iconset.appendingPathComponent(filename).path])
    }
}
try run("/usr/bin/iconutil", ["-c", "icns", iconset.path,
                              "-o", output.appendingPathComponent("icon.icns").path])
print("Created desktop/assets/icon.icns (16–1024 px, 1× and 2×)")

try run("/usr/bin/sips", ["-z", "256", "256", output.appendingPathComponent("icon.png").path,
                         "--out", root.appendingPathComponent("public/assets/noah/favicon.png").path])
print("Created public/assets/noah/favicon.png")
