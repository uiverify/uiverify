# iOS / Swift: produce screenshots with swift-snapshot-testing

A native iOS app can't render in a browser, so it takes the screenshot-upload path. The simplest way to
produce the PNGs is [swift-snapshot-testing](https://github.com/pointfreeco/swift-snapshot-testing)
(Point-Free): it renders a SwiftUI or UIKit view inside an ordinary unit test on the simulator. No UI test
target, no app launch, no status bar to freeze. Prefer it over XCUITest (whose screenshots are buried in the
`.xcresult` bundle) unless the user already has an XCUITest screenshot flow.

## 1. Add the package and the helper

Add `https://github.com/pointfreeco/swift-snapshot-testing` to the **unit test target** (Swift Package
Manager), then add this helper to that target:

```swift
// AppTests/UIVerifyScreenshot.swift
import Foundation
import SnapshotTesting
import SwiftUI

func uiverifyScreenshot<V: View>(_ view: V, named name: String, testName: String = #function) {
  let dir = ProcessInfo.processInfo.environment["UIVERIFY_SCREENSHOTS_DIR"]
    ?? NSTemporaryDirectory() + "uiverify-screenshots"
  // record: .all always writes the PNG; verifySnapshot returns a message instead of failing the test
  _ = verifySnapshot(
    of: view,
    as: .image(layout: .device(config: .iPhone13)),
    named: name,
    record: .all,
    snapshotDirectory: dir,
    testName: testName
  )
}
```

Why `verifySnapshot` and not `assertSnapshot`: the baseline lives in UI Verify, not in `__Snapshots__/`, so
the test should only *write* the PNG. `assertSnapshot` in record mode always fails the test ("Record mode is
on"); `verifySnapshot` returns that message instead, and the helper discards it. Don't commit
`__Snapshots__/` and don't add `assertSnapshot` calls for these screens.

## 2. One test per screen state

```swift
// AppTests/CheckoutScreenshots.swift
import XCTest
@testable import App

final class CheckoutScreenshots: XCTestCase {
  func testCart() {
    uiverifyScreenshot(CartView(items: .fixture), named: "cart")
  }
}
```

The file is `<test name>.<name>.png`, so this uploads as the key `testCart.cart`. Keep test and screenshot
names stable: renaming one is a new screen with no baseline. Feed views fixture data, never live network
calls, and set dates and locale explicitly (`.environment(\.locale, Locale(identifier: "en_US"))`).

## 3. Run and upload

`xcodebuild` passes `TEST_RUNNER_`-prefixed variables into the test process (prefix stripped), and a
simulator test can write straight to the host filesystem:

```bash
TEST_RUNNER_UIVERIFY_SCREENSHOTS_DIR="$PWD/screenshots" \
  xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'
UIVERIFY_API_KEY=uv_proj_… npx uiverify upload --screenshots ./screenshots
```

Mid-task, preview the change without a PR with `npx uiverify check --screenshots ./screenshots` (see
`check-visual-changes`).

## 4. CI

Same workflow as the other paths, but the job runs on **macOS** (the iOS simulator does not run on Linux),
and the PNG step replaces the build step:

```yaml
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: |
          TEST_RUNNER_UIVERIFY_SCREENSHOTS_DIR="$PWD/screenshots" \
            xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16'
      - run: npx uiverify upload --screenshots ./screenshots
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
```

Determinism is the harness's job here (UI Verify renders nothing): pin the runner image and Xcode version so
the simulator runtime doesn't drift (rendering differs between iOS versions). `layout: .device(config:
.iPhone13)` already fixes the screen size and traits, whichever simulator runs the test.
