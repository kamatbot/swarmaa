# Subframe Motion for Swarmaa

This document outlines the motion animation patterns implemented for Swarmaa, adapted from the [Subframe Motion Library](https://www.subframe.com/motion) to match Swarmaa’s **Muted Kind Swarm** design system.

---

## Design Principles & Tokens

1. **Brand Aesthetic**:
   * Ink `#15111F` outlines and typography on Paper `#F4EFE6` ground.
   * Hard offset shadows (`2px` to `3px`, unblurred) that compress flat on physical press.
   * Accents: Lime `#CFE08A` (primary / verified), Coral `#E8836B` (attention / error), Sky `#B7CCE8` (running), Sage `#D6E3A6` (review), Lilac `#D9CDEE` (agents).
2. **Timing & Deceleration**:
   * Tactile button press: `<100ms` down compression, `160ms` spring return.
   * Transits & disclosures: `200ms` to `250ms` decelerating curves (`cubic-bezier(0.2, 0.8, 0.2, 1)`).
   * Exits are approximately 30% faster than entrances.
3. **Inclusive Motion (WCAG & Accessibility)**:
   * Honors `prefers-reduced-motion` across both native macOS SwiftUI (`@Environment(\.accessibilityReduceMotion)`) and Web/HTML (`@media (prefers-reduced-motion: reduce)`).
   * All interactive actions execute instantly when reduced motion is enabled without altering final layout or functionality.

---

## Implemented Motion Patterns

| Pattern | Subframe Source | Swarmaa Usage | Native SwiftUI Component |
| :--- | :--- | :--- | :--- |
| **1. Tactile Press** | [`press-depth`](https://www.subframe.com/motion/press-depth) | Buttons lift 1px on hover and compress 2px flat on active press with collapsing hard shadow. | `KSButtonStyle` / `KSButtonBody` in `KS.swift` |
| **2. Crew Presence** | [`presence-pile`](https://www.subframe.com/motion/presence-pile) | Collapsed avatar stack fans out horizontally (240ms ease-out spring) on click with agent card popup. | `KSCrewPresencePile` in `KS.swift` |
| **3. Tool Trace Stack** | [`tool-call-stack`](https://www.subframe.com/motion/tool-call-stack) | Step disclosure with rotating chevrons (90°) and smoothly expandable subtask / command execution logs. | `SwarmStepRow` in `ThreadView.swift` |
| **4. Live Stream Autoscroll** | [`answer-stream`](https://www.subframe.com/motion/answer-stream) | Auto-pins chat to live tail, releasing pin and displaying a floating "Latest response ↓" pill when scrolled up. Includes animated pulsing thought indicators. | `ThreadView` & `TypingDotsIndicator` in `ThreadView.swift` |
| **5. Activity Capsule** | [`activity-capsule`](https://www.subframe.com/motion/activity-capsule) | Background task card collapses into a compact persistent pill; 16 segments illuminate as work advances. | `KSActivityCapsule` in `TasksViews.swift` |
| **6. Review Disclosure** | [`review-disclosure`](https://www.subframe.com/motion/review-disclosure) | Safety gate checklist for unverified worktree patches with dynamic approval count button. | `KSReviewDisclosure` in `TasksViews.swift` |

---

## How to Review

### 1. Interactive Web Showcase
Open [`design/launch-kit/motion-showcase.html`](file:///Users/mk/Projects/swarma/design/launch-kit/motion-showcase.html) in any browser. It demonstrates all 6 patterns interactively, with an instant toggle to simulate reduced motion.

### 2. Native macOS App Tests
Run the dedicated motion test suite:
```bash
cd Mac-app
xcodegen generate
xcodebuild test -project Codenotch.xcodeproj -scheme Codenotch -destination 'platform=macOS,arch=arm64' -only-testing:CodenotchTests/TeamsMotionTests
```

### 3. Core Repository Invariants
Verify the whole project still satisfies all repo validation requirements:
```bash
npm run typecheck
npm test
npm run build
```
