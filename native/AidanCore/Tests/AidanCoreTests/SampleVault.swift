@testable import AidanCore
import Foundation
import XCTest

struct LoadedSamples {
    var notes: [ReadNote]
    var unreadable: [String]
    var files: [String]
}

func sampleRoot() throws -> URL {
    guard let url = Bundle.module.url(forResource: "SampleNotes", withExtension: nil) else {
        XCTFail("SampleNotes is missing from the test bundle")
        throw CocoaError(.fileNoSuchFile)
    }
    return url
}

func loadSamples(reading: PlainMarkerReading = .asteriskIsOpenTask) throws -> LoadedSamples {
    let root = try sampleRoot().standardizedFileURL
    let rootPath = root.path
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey]) else {
        XCTFail("Could not walk SampleNotes")
        throw CocoaError(.fileReadUnknown)
    }
    var notes: [ReadNote] = []
    var unreadable: [String] = []
    var files: [String] = []
    for case let item as URL in enumerator {
        let values = try item.resourceValues(forKeys: [.isDirectoryKey])
        if values.isDirectory == true { continue }
        let path = item.standardizedFileURL.path
        guard path.hasPrefix(rootPath + "/") else { continue }
        let relative = String(path.dropFirst(rootPath.count + 1))
        files.append(relative)
        let data = try Data(contentsOf: item)
        if let text = NoteText.decode(data) {
            notes.append(ReadNote(path: relative, text: text, plainMarkers: reading))
        } else {
            unreadable.append(relative)
        }
    }
    notes.sort { $0.path < $1.path }
    unreadable.sort()
    files.sort()
    return LoadedSamples(notes: notes, unreadable: unreadable, files: files)
}

func utcDate(year: Int, month: Int, day: Int, hour: Int, minute: Int) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
}

func calendarGap(from earlier: CalendarDay, to later: CalendarDay, timeZone: TimeZone) -> Int {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let start = calendar.date(from: DateComponents(year: earlier.year, month: earlier.month, day: earlier.day, hour: 12))!
    let end = calendar.date(from: DateComponents(year: later.year, month: later.month, day: later.day, hour: 12))!
    return calendar.dateComponents([.day], from: start, to: end).day!
}

struct BroughtRow: Equatable, CustomStringConvertible {
    var year: Int
    var month: Int
    var day: Int
    var key: String
    var count: Int
    var path: String

    var description: String { "\(year)-\(month)-\(day) \(key) \(count) \(path)" }
}

func broughtRows(_ result: BroughtForwardResult) -> [BroughtRow] {
    result.groups.flatMap { group in
        group.tasks.map { task in
            BroughtRow(
                year: group.sourceDay.year,
                month: group.sourceDay.month,
                day: group.sourceDay.day,
                key: TaskText.key(for: task.line) ?? "",
                count: task.moveCount,
                path: task.source.path
            )
        }
    }
}

func projectRows(_ result: BroughtForwardResult) -> [String] {
    result.projectTasksDueToday.map { task in
        "\(task.source.path) \(TaskText.key(for: task.line) ?? "")"
    }
}
