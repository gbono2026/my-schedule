import Foundation
import Capacitor
import HealthKit

/// Native HealthKit **background delivery** for Meridian.
///
/// The `@capgo/capacitor-health` plugin only does on-demand reads, so the web
/// layer can sync HealthKit only while the app is open/foregrounded. This plugin
/// registers `HKObserverQuery`s with `enableBackgroundDelivery`, so iOS wakes the
/// app when new health data lands — even when it is backgrounded or closed — and
/// we read + POST the metrics to the server entirely in Swift (the WebView/JS is
/// not running during a background launch).
///
/// It posts the same flat payload, to the same `/health/native` endpoint, with the
/// same field names and units (the user's Apple Health preferred units) as the
/// foreground `Native.syncHealth()` path in `index.html`, so the two stay consistent.
@objc(HealthBackgroundPlugin)
public class HealthBackgroundPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthBackgroundPlugin"
    public let jsName = "HealthBackground"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncNow", returnType: CAPPluginReturnPromise)
    ]

    private let healthStore = HKHealthStore()
    private var observerQueries: [HKObserverQuery] = []

    // Persist config so background launches (where JS never runs) can re-arm.
    private static let kServerUrl = "meridian.health.serverUrl"
    private static let kEnabled = "meridian.health.bgEnabled"
    // Debounce: several observers can fire near-simultaneously.
    private static var lastSync: Date = .distantPast
    private static let minSyncInterval: TimeInterval = 5 * 60

    // MARK: - Lifecycle

    /// Called on every app start (including background launches triggered by
    /// HealthKit). If the user previously enabled background sync, re-arm the
    /// observers without requiring the WebView/JS to load.
    override public func load() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Self.kEnabled),
           let url = defaults.string(forKey: Self.kServerUrl), !url.isEmpty {
            setupBackgroundDelivery()
        }
    }

    // MARK: - JS API

    /// enable({ serverUrl }) — request authorization (foreground), persist config,
    /// and arm background delivery.
    @objc func enable(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("HealthKit is not available on this device")
            return
        }
        if let url = call.getString("serverUrl"), !url.isEmpty {
            UserDefaults.standard.set(url, forKey: Self.kServerUrl)
        }
        guard UserDefaults.standard.string(forKey: Self.kServerUrl)?.isEmpty == false else {
            call.reject("Missing serverUrl")
            return
        }

        let readTypes = Set(allReadTypes())
        healthStore.requestAuthorization(toShare: nil, read: readTypes) { [weak self] _, error in
            guard let self = self else { return }
            if let error = error {
                call.reject("Health authorization failed: \(error.localizedDescription)")
                return
            }
            UserDefaults.standard.set(true, forKey: Self.kEnabled)
            self.setupBackgroundDelivery()
            call.resolve(["enabled": true])
        }
    }

    /// disable() — turn off background delivery and forget the config.
    @objc func disable(_ call: CAPPluginCall) {
        UserDefaults.standard.set(false, forKey: Self.kEnabled)
        for q in observerQueries { healthStore.stop(q) }
        observerQueries.removeAll()
        let group = DispatchGroup()
        for type in observedSampleTypes() {
            group.enter()
            healthStore.disableBackgroundDelivery(for: type) { _, _ in group.leave() }
        }
        group.notify(queue: .main) { call.resolve(["enabled": false]) }
    }

    /// syncNow() — force a read + POST immediately (handy for testing).
    @objc func syncNow(_ call: CAPPluginCall) {
        performSync(force: true) { posted in
            call.resolve(["posted": posted])
        }
    }

    // MARK: - HealthKit types

    private func observedSampleTypes() -> [HKSampleType] {
        var types: [HKSampleType] = []
        let quantityIds: [HKQuantityTypeIdentifier] = [
            .stepCount, .activeEnergyBurned, .distanceWalkingRunning,
            .restingHeartRate, .heartRateVariabilitySDNN, .bodyMass
        ]
        for id in quantityIds {
            if let t = HKObjectType.quantityType(forIdentifier: id) { types.append(t) }
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.append(sleep)
        }
        return types
    }

    private func allReadTypes() -> [HKObjectType] { observedSampleTypes() }

    // MARK: - Background delivery wiring

    private func setupBackgroundDelivery() {
        // Clear any existing observers (e.g. re-arm on a fresh launch).
        for q in observerQueries { healthStore.stop(q) }
        observerQueries.removeAll()

        for type in observedSampleTypes() {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                guard let self = self else { completion(); return }
                if error != nil { completion(); return }
                // Read everything once, POST, then tell HealthKit we're done.
                self.performSync(force: false) { _ in completion() }
            }
            healthStore.execute(query)
            observerQueries.append(query)
            // Hourly is the finest cadence HealthKit grants for most types.
            healthStore.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    // MARK: - Read + POST (mirrors Native.syncHealth in index.html)

    private func performSync(force: Bool, completion: @escaping (Bool) -> Void) {
        if !force {
            let since = Date().timeIntervalSince(Self.lastSync)
            if since < Self.minSyncInterval { completion(false); return }
        }
        Self.lastSync = Date()

        guard let serverUrl = UserDefaults.standard.string(forKey: Self.kServerUrl), !serverUrl.isEmpty else {
            completion(false); return
        }

        let now = Date()
        let dayStart = Calendar.current.startOfDay(for: now)
        // Sleep window: from 6pm the previous day, to capture last night.
        let sleepStart = dayStart.addingTimeInterval(-6 * 3600)

        var out: [String: Any] = ["date": Self.utcDateString(now)]
        let group = DispatchGroup()
        let lock = NSLock()
        func put(_ key: String, _ value: Any) { lock.lock(); out[key] = value; lock.unlock() }

        // First resolve the user's preferred display units for weight + distance so
        // background numbers match what they see in Apple Health (and the capgo path).
        group.enter()
        var weightUnit = HKUnit.gramUnit(with: .kilo)
        var distanceUnit = HKUnit.meter()
        var preferredTypes: Set<HKQuantityType> = []
        if let bm = HKObjectType.quantityType(forIdentifier: .bodyMass) { preferredTypes.insert(bm) }
        if let d = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) { preferredTypes.insert(d) }
        healthStore.preferredUnits(for: preferredTypes) { units, _ in
            if let bm = HKObjectType.quantityType(forIdentifier: .bodyMass), let u = units[bm] { weightUnit = u }
            if let d = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning), let u = units[d] { distanceUnit = u }
            group.leave()
        }

        group.notify(queue: .global()) {
            let inner = DispatchGroup()

            // steps (sum)
            inner.enter()
            self.sumQuantity(.stepCount, unit: .count(), start: dayStart, end: now) { v in
                if let v = v { put("steps", Int(v.rounded())) }; inner.leave()
            }
            // active calories (sum)
            inner.enter()
            self.sumQuantity(.activeEnergyBurned, unit: .kilocalorie(), start: dayStart, end: now) { v in
                if let v = v { put("activeCalories", Int(v.rounded())) }; inner.leave()
            }
            // distance (sum, user's preferred unit)
            inner.enter()
            self.sumQuantity(.distanceWalkingRunning, unit: distanceUnit, start: dayStart, end: now) { v in
                if let v = v { put("distance", (v * 100).rounded() / 100) }; inner.leave()
            }
            // resting heart rate (average)
            inner.enter()
            self.avgQuantity(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), start: dayStart, end: now) { v in
                if let v = v { put("restingHR", Int(v.rounded())) }; inner.leave()
            }
            // HRV (average, ms)
            inner.enter()
            self.avgQuantity(.heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli), start: dayStart, end: now) { v in
                if let v = v { put("hrv", (v * 10).rounded() / 10) }; inner.leave()
            }
            // weight (latest in last 30 days, user's preferred unit)
            inner.enter()
            self.latestQuantity(.bodyMass, unit: weightUnit, start: dayStart.addingTimeInterval(-30 * 86400), end: now) { v in
                if let v = v { put("weight", (v * 10).rounded() / 10) }; inner.leave()
            }
            // sleep stages (category)
            inner.enter()
            self.readSleep(start: sleepStart, end: now) { sleep in
                if let sleep = sleep { for (k, val) in sleep { put(k, val) } }; inner.leave()
            }

            inner.notify(queue: .global()) {
                // Only POST if we actually read something beyond the date.
                if out.count <= 1 { completion(false); return }
                self.post(serverUrl: serverUrl, payload: out, completion: completion)
            }
        }
    }

    // MARK: - Query helpers

    private func sumQuantity(_ id: HKQuantityTypeIdentifier, unit: HKUnit, start: Date, end: Date,
                             _ completion: @escaping (Double?) -> Void) {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { completion(nil); return }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let q = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: pred, options: .cumulativeSum) { _, res, _ in
            completion(res?.sumQuantity()?.doubleValue(for: unit))
        }
        healthStore.execute(q)
    }

    private func avgQuantity(_ id: HKQuantityTypeIdentifier, unit: HKUnit, start: Date, end: Date,
                             _ completion: @escaping (Double?) -> Void) {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { completion(nil); return }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let q = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: pred, options: .discreteAverage) { _, res, _ in
            completion(res?.averageQuantity()?.doubleValue(for: unit))
        }
        healthStore.execute(q)
    }

    private func latestQuantity(_ id: HKQuantityTypeIdentifier, unit: HKUnit, start: Date, end: Date,
                                _ completion: @escaping (Double?) -> Void) {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { completion(nil); return }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let q = HKSampleQuery(sampleType: type, predicate: pred, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
            guard let s = samples?.first as? HKQuantitySample else { completion(nil); return }
            completion(s.quantity.doubleValue(for: unit))
        }
        healthStore.execute(q)
    }

    /// Sum sleep-stage minutes over the window, returned in HOURS, matching the
    /// field names the server expects (sleep, sleepDeep, sleepREM, sleepCore, sleepAwake).
    private func readSleep(start: Date, end: Date, _ completion: @escaping ([String: Double]?) -> Void) {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { completion(nil); return }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let q = HKSampleQuery(sampleType: type, predicate: pred, limit: 500, sortDescriptors: nil) { _, samples, _ in
            guard let samples = samples as? [HKCategorySample], !samples.isEmpty else { completion(nil); return }
            var deep = 0.0, rem = 0.0, light = 0.0, awake = 0.0, asleep = 0.0
            for s in samples {
                let mins = s.endDate.timeIntervalSince(s.startDate) / 60.0
                guard mins > 0 else { continue }
                if #available(iOS 16.0, *) {
                    // Granular sleep stages (iOS 16+).
                    switch s.value {
                    case HKCategoryValueSleepAnalysis.asleepDeep.rawValue: deep += mins
                    case HKCategoryValueSleepAnalysis.asleepREM.rawValue: rem += mins
                    case HKCategoryValueSleepAnalysis.asleepCore.rawValue: light += mins
                    case HKCategoryValueSleepAnalysis.awake.rawValue: awake += mins
                    case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue: asleep += mins
                    default: break // inBed ignored
                    }
                } else {
                    // Pre-iOS 16 only distinguishes inBed (0) vs asleep (1).
                    if s.value == HKCategoryValueSleepAnalysis.asleep.rawValue { asleep += mins }
                }
            }
            let h = { (m: Double) -> Double in (m / 60.0 * 100).rounded() / 100 }
            let totalMin = deep + rem + light + asleep
            if totalMin <= 0 && awake <= 0 { completion(nil); return }
            completion([
                "sleep": h(totalMin),
                "sleepDeep": h(deep),
                "sleepREM": h(rem),
                "sleepCore": h(light),
                "sleepAwake": h(awake)
            ])
        }
        healthStore.execute(q)
    }

    // MARK: - Networking

    private func post(serverUrl: String, payload: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: serverUrl + "/health/native"),
              let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(false); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let task = URLSession.shared.dataTask(with: req) { _, response, _ in
            let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            completion(ok)
        }
        task.resume()
    }

    // MARK: - Utils

    /// Matches the JS `ymd()` helper: the UTC calendar date as YYYY-MM-DD.
    private static func utcDateString(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "UTC")
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: date)
    }
}
