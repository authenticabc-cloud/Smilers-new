#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================
## user_problem_statement: Convert existing Smilers web experience into an Expo native app with Convex, Hercules OIDC, phone verification, and fully functional Phase 1 navigation/screens.
## backend: []
## frontend:
##   - task: "OIDC callback deep-link handling"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/+not-found.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Added catch-all callback handling, PKCE state restore, and verified sign-in badge in preview."
##   - task: "Phase 1 utility screens and settings navigation"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/settings.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Added emergency, AI chat, blocked users, notifications, earnings, and seven coming-soon screens. Verified settings navigation plus key direct routes in preview."
##       - working: true
##         agent: "main"
##         comment: "After test-agent feedback, verified /settings navigation, /app-lock, /blocked, /notifications, /earnings, /emergency, /ai-chat, and /chat-once again in preview."
##   - task: "Chat appearance screenshot redesign"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat-appearance.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Rebuilt /chat-appearance to visually match the latest user-provided reference: dark header, dual tabs, large wallpaper preview, screenshot-style wallpaper cards, and a matching Bubble Theme tab while preserving local persistence. Self-verified both tabs in preview."
##       - working: false
##         agent: "testing"
##         comment: "Route and interactions were stable, but the back button touch target was 42x42 which is below the recommended 44x44 minimum."
##       - working: true
##         agent: "main"
##         comment: "Increased the chat appearance back button to 46x46 and re-ran preview verification so the touch target now meets the minimum size guidance."
##   - task: "Android EAS WebRTC bundle fix"
##     implemented: true
##     working: true
##     file: "/app/frontend/package.json"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "Production Android build failed in EAGER_BUNDLE with `Missing \"./index\" specifier in \"event-target-shim\" package` from react-native-webrtc -> app/call/[conversationId].tsx."
##       - working: true
##         agent: "main"
##         comment: "Applied a durable deploy-safe fix: added npm `prepare` hook for `scripts/patch-rn-webrtc.js` so the patch still runs when deployment overwrites postinstall, and added npm override forcing react-native-webrtc to use event-target-shim@5.0.1 which supports the `/index` subpath. Local Android export advanced past the previous event-target-shim bundle error; the next local stop was Hermes bytecode generation in this container, which is separate from the original EAS blocker."
##   - task: "Android EAS tarball corruption cleanup"
##     implemented: true
##     working: true
##     file: "/app/frontend/.easignore"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "A later production build progressed further but failed while uploading the project tarball with `ENOENT: no such file or directory, lstat '/workspace/source/frontend/��@@��9@8'`."
##       - working: true
##         agent: "main"
##         comment: "Found a corrupt filename in `/app/frontend` with inode 133032 (`b'\\x01\\x90\\xf8@@\\xd0\\xc39@8'`), deleted it directly, re-scanned the entire frontend tree to confirm zero invalid `@@` / control-character filenames remain, and hardened `.easignore` with `*@@*`, `*.pyc`, and `__pycache__/` exclusions."
##   - task: "Groups tab native crash fix"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/(tabs)/groups.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "On the native build, tapping the Groups tab crashes the app."
##       - working: true
##         agent: "main"
##         comment: "Replaced raw Convex `useQuery` calls in the Groups tab with `useSafeConvexQuery`, and delayed the optional conferences query until the Conferences sub-tab is active. This prevents missing backend functions or optional endpoints from crashing the screen on tab open. Added a loading state for the active sub-tab."
##       - working: true
##         agent: "main"
##         comment: "After testing-agent review, also hardened list identity/navigation by adding safe item ID extraction plus conference-aware row routing so missing `_id` values do not create undefined keys or unsafe presses."
##   - task: "Groups plus / conferences plus / call route crash fixes"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/(tabs)/groups.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "Groups `+` opened Chat Once instead of new group; Conferences tab felt shaky/loading; Conferences `+` background-crashed; pressing voice/video call buttons crashed the app."
##       - working: true
##         agent: "main"
##         comment: "Reworked Groups and Conferences flows: Groups `+` now opens `/groups-create`, Conferences `+` now opens `/conference-create`, Conferences tab now uses existing group conversations as conference-ready entries instead of depending on an optional missing backend endpoint, and call routing now uses safe Convex queries plus removed the unguarded `useKeepAwake()` crash source from `/call/[conversationId]`. Self-verified `/groups-create`, `/conference-create`, `/call/testconversation1?type=voice`, and `/call/testconversation1?type=video` in preview without red-screen crashes."
##       - working: true
##         agent: "main"
##         comment: "After testing-agent review, also gated call-screen Convex queries behind auth so unauthenticated/invalid conversation preview routes stop producing avoidable runtime server-error noise while remaining stable."
##       - working: true
##         agent: "main"
##         comment: "User then requested the Conferences view match a provided screenshot and reported native call taps still backgrounding the app. I redesigned the Conferences state in `/app/frontend/app/(tabs)/groups.tsx` to a dedicated screenshot-style layout with back arrow, search, invite-code row, badge pills, and SOS button; and I moved `Audio.setAudioModeAsync` out of mount-time execution in `/app/frontend/app/call/[conversationId].tsx`, only applying it after permissions pass, while setting `staysActiveInBackground: false` plus adding iOS `UIBackgroundModes: ['audio']` support in `app.json`."
##       - working: true
##         agent: "main"
##         comment: "After the user confirmed the call crash is Android-only, I added an Android-specific mount delay plus lazy `require()` loading for `CallSession` and `RTCViewWrapper` inside `/app/frontend/app/call/[conversationId].tsx` so WebRTC native modules do not initialize at route-import time before the Android view hierarchy is ready."
##   - task: "Trustees page screenshot redesign"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/trustees.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Rebuilt `/trustees` to mirror the latest reference: dark brown header, explanatory panel, large trustee cards, dashed Add Trustee card, and a bottom-sheet Add Trustee flow with a gold-outlined search box. Add flow now searches Smilers contacts by name or phone using `api.contacts.getContacts`, and only contacts from that Smilers contact list can be added."
##       - working: true
##         agent: "testing"
##         comment: "Preview validation passed: `/trustees` loaded cleanly, Add Trustee sheet opened correctly, search field accepted input, and the Smilers-only empty-state behavior rendered correctly when no eligible contacts were available."
##   - task: "Message language screenshot redesign"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/languages.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User explicitly skipped Login and Sign Up, then provided the Message Language web screenshot and requested a matching language picker with Akan (Asante Twi) and all recognized languages."
##       - working: true
##         agent: "main"
##         comment: "Reworked `/languages` from a multi-select translation-skip screen into a screenshot-style single-select Message Language picker, added Akan (Asante Twi) plus more recognized languages including Kazakh, and updated the profile language label to show the full mapped language name instead of a raw code."
##       - working: true
##         agent: "testing"
##         comment: "Testing confirmed `/languages` loads without runtime errors and searching `Ak` returns Akan (Asante Twi), Kazakh, and Slovak. Profile row mapping was confirmed in code review, though the auth-gated profile UI was not exercised end-to-end in this run."
##   - task: "Chat screen screenshot restyle"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User provided multiple chat screenshots and asked to apply the chat instructions while preserving the separate Chat Appearance system already built."
##       - working: true
##         agent: "main"
##         comment: "Reworked the chat route with a screenshot-style brown header, encryption banner, date chips, warmer composer bar, emoji/attachment/templates/schedule actions, and enhanced link/file bubble presentation while preserving wallpaper and bubble colors from Chat Appearance."
##       - working: true
##         agent: "testing"
##         comment: "Testing validated `/chat/test-conversation` route stability and confirmed the new header, encryption banner, and composer row render correctly. Live message interaction could not be fully exercised in preview because that route resolved to the conversation-unavailable state."
##       - working: true
##         agent: "main"
##         comment: "Applied the final QA note by increasing chat header and composer secondary icon tap targets to at least 44x44 while preserving the screenshot direction."
##       - working: true
##         agent: "user"
##         comment: "User then compared the web and native chat screens and asked for the conversation UI to mirror the web app more closely, especially font sizes and chat boxes/bubbles."
##       - working: true
##         agent: "main"
##         comment: "Refined the chat UI toward the web look: removed forced uppercase title styling, switched date/time formatting to the web-style day-first / 24-hour format, reduced default message text sizing, tightened MediaBubble radius/tail/padding, softened bubble chrome, and spot-verified the chat route still renders in preview after the update."
##   - task: "Chat composer keyboard-safe rich text tools"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User then asked for three final chat-composer fixes before testing: the composer should move above the keyboard like the web app, a bold `B` tool should appear, and a color picker should allow black / red / blue / green / gold text like the screenshot."
##       - working: true
##         agent: "main"
##         comment: "Updated the chat route with Android-safe keyboard avoidance, added a formatting toolbar above the composer with bold and palette controls, added five draft color choices, and introduced lightweight rich-text tag parsing so sent messages can render bold and colored text bubbles. Self-verified that the chat route still renders in preview; full signed-in composer/keyboard parity still needs on-device validation because the unauthenticated preview cannot reach the live conversation composer state."
##   - task: "Ringtone asset refresh"
##     implemented: true
##     working: true
##     file: "/app/frontend/assets/sounds/smilers_never_cry_2.mp3"
##     stuck_count: 0
##     priority: "medium"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User uploaded replacement `Smilers_Never_Cry_2.mp3` and `Smilers_Never_Cry_3.mp3` files and asked to add them to the ringtones."
##       - working: true
##         agent: "main"
##         comment: "Replaced the bundled lowercase ringtone assets at `/assets/sounds/smilers_never_cry_2.mp3` and `/assets/sounds/smilers_never_cry_3.mp3`. The ringtone catalog already referenced these IDs, so no code changes were needed. Self-verified the `/ringtones` screen still loads and lists both entries in preview."
##   - task: "Two-part message notification sound"
##     implemented: true
##     working: true
##     file: "/app/frontend/assets/sounds/message_notification.mp3"
##     stuck_count: 0
##     priority: "medium"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User uploaded a new MP3 and asked for all received message notifications to play a beep followed by that sound."
##       - working: true
##         agent: "main"
##         comment: "Backed up the existing bundled message beep, downloaded the new uploaded MP3 as a follow-up sound, concatenated both into the existing `message_notification.mp3` asset so foreground realtime message alerts and native push channels continue using the same filename, and updated the foreground notification hook comment to match the new two-part behavior. Audio analysis confirms the final file behaves like a short repeated two-part notification clip."
##   - task: "Chat voice-note controls + disappearing messages + send money redesign"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/send-money.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User requested three new screenshot-driven updates: voice recording should have pause and cancel buttons, disappearing messages should use a small top button near the call icons that opens options, and Send Money should match the provided screenshots."
##       - working: true
##         agent: "main"
##         comment: "Updated `/chat/[conversationId]` with pause/resume/cancel/send voice-note controls plus waveform styling, added a top disappearing-messages button and option sheet, and rebuilt `/send-money` to a screenshot-style Send / Requests / History experience with transfer and contact-picker modals."
##       - working: false
##         agent: "testing"
##         comment: "Testing found one real bug: selecting a disappearing-messages option crashed because `writeStoredJson` was missing in the chat route imports."
##       - working: true
##         agent: "main"
##         comment: "Imported `writeStoredJson`, restarted Expo, and self-verified the disappearing-messages sheet now accepts the 24h option without crashing. `/send-money` also reopened cleanly in preview after the fix."
##   - task: "Android production call crash RCA and WebRTC import refactor"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/webrtc/CallSession.ts"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "In the production Android APK, tapping voice or video call still crashed the app. First attempt showed 'Smilers has stopped'; later attempts sent the app to background."
##       - working: false
##         agent: "troubleshooting"
##         comment: "Root cause identified as native `react-native-webrtc` initialization happening too early because `CallSession.ts` and `RTCViewWrapper.ts` still had top-level imports from `react-native-webrtc`, which execute immediately in production APKs even when the route lazy-loads them later."
##       - working: true
##         agent: "main"
##         comment: "Refactored `CallSession.ts` to use dynamic `await import('react-native-webrtc')` loading through a cached getter, changed `createPeerConnection()` to async, updated the call route to await it, and rewrote `RTCViewWrapper.ts` so `react-native-webrtc` is only required at render time instead of module load time. Preview call route still renders after the refactor."
##   - task: "Call screen web-parity refinements"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/call/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User compared the web call screen against the native voice-call screen and requested three parity fixes: show the actual contact name instead of `Smilers`, expose audio-output choice UI, and add Screen / Add participant buttons like the web app."
##       - working: true
##         agent: "main"
##         comment: "Reworked `/call/[conversationId]` toward the web screenshots: added smarter contact-name resolution, swapped the filled avatar for an outlined call orb, rebuilt the voice-call action row to Mute / Audio / Screen / Add with labels under the circles, added the web-style Audio Output card (Earpiece / Speaker / Bluetooth), and self-verified the call screen plus audio menu in mobile preview screenshots. The Add participant button is present for parity but the actual live invite/escalation flow is not wired yet."
##   - task: "Add participant / conference-escalation flow"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/call/[conversationId].tsx"
##     stuck_count: 1
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "user"
##         comment: "User then provided the exact Add to call and Privacy Settings screenshots and asked for the real add-participant flow to match them, including the conference escalation path."
##       - working: false
##         agent: "main"
##         comment: "First implementation had a render-order bug (`Cannot access openAddParticipantFlow before initialization`) when the call screen mounted."
##       - working: true
##         agent: "main"
##         comment: "Fixed the render-order bug, added the screenshot-matched Add to call overlay and Privacy Settings modal inside the live call route, and wired add-participant to create a new group conversation via `conversations.createGroup` before replacing the route with the new conference call. Self-verified the add-to-call overlay opens cleanly in mobile preview. Privacy hide/show selection is captured in the flow and passed forward, but backend participant-number visibility enforcement is still pending because no dedicated API exists in this codebase yet."
##   - task: "EAS update export syntax fix for RTCView wrapper"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/webrtc/RTCViewWrapper.ts"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "Deployment log then failed during `eas-update` export with `SyntaxError: /workspace/source/frontend/src/lib/webrtc/RTCViewWrapper.ts: Unexpected token` because JSX existed inside a `.ts` file."
##       - working: true
##         agent: "main"
##         comment: "Removed JSX from `RTCViewWrapper.ts` and replaced it with `React.createElement(...)` so the file remains valid TypeScript during EAS export. After the fix, the preview call route still opens and renders the voice-call UI."
##   - task: "Safe Convex fallback for optional Phase 1 endpoints"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/hooks/useSafeConvexQuery.ts"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Replaced direct reactive queries on optional endpoints with safe manual queries so missing Convex functions no longer crash the UI."
##   - task: "Web-safe tabs and push notification hooks"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/push/usePushNotifications.ts"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: false
##         agent: "testing"
##         comment: "Chats route crashed on web because usePushNotifications called web-unsupported Expo Notifications APIs and tabs layout redirected too early."
##       - working: true
##         agent: "main"
##         comment: "Added web guards to push APIs, switched tab auth gating to render-time Redirects, fixed App Lock icon, and self-verified /chats now redirects safely to sign-in with no red overlay."
##       - working: true
##         agent: "main"
##         comment: "Follow-up hardening for iteration 31: added `usePushNotifications.web.ts` so web preview no longer bundles native push setup, and replaced top-level `expo-notifications` imports in `app/call/[conversationId].tsx` and `app/ringtones.tsx` with native-only lazy requires. Self-verified the previous web console warning about push-token listeners is now gone from the preview boot logs."
##   - task: "Phase 2A.1 chat actions"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Installed expo-clipboard@~8.0.8 and replaced chat screen with reply, reactions, copy, forward, star, delete, quoted reply rendering, deleted placeholders, and haptic long-press actions. Preview boot still works and TS baseline remains clean except existing third-party JSX typing issue in react-native-country-codes-picker."
##       - working: false
##         agent: "testing"
##         comment: "Auth automation could not reach a live chat; direct /chat/test-conversation route crashed on Convex server error."
##       - working: true
##         agent: "main"
##         comment: "Added sign-in readiness gating plus safe chat fallback for invalid/unauthorized conversation IDs. Self-verified root preview still boots and /chat/test-conversation now shows fallback UI instead of crashing. Authenticated long-press actions still need a real signed-in conversation test."
##   - task: "Phase 2A.2a image attachments"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Installed Expo SDK-aligned media packages, added uploadFile helper, AttachmentSheet, MediaBubble, composer upload bar, image send/camera hooks, image forwarding with storageId preservation, and full-screen image viewer. Self-verified root preview still boots and invalid chat route degrades to fallback instead of hanging."
##       - working: false
##         agent: "testing"
##         comment: "Invalid chat route visually fell back, but runtime still logged loop/server errors; auth popup was not reached in that automation run."
##       - working: true
##         agent: "main"
##         comment: "Added hard validation for malformed conversation IDs so invalid routes skip Convex queries entirely, re-verified fallback UI, and confirmed sign-in button now opens the Hercules auth popup in web automation. End-to-end media send still needs a real authenticated chat conversation on device/browser."
##   - task: "Ads module MVP"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/(tabs)/ads.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: true
##         agent: "main"
##         comment: "Added Ads tab wiring, Browse/My Ads screen, Create Ad form, Admin Ads Review screen, country selector modal, debounced search helper, and standard 195-country list. Self-verified /ads/create and /ads/review in preview."
##       - working: false
##         agent: "testing"
##         comment: "Ads create route stayed stable, but unauthenticated submit still hit Convex server error instead of showing an explicit sign-in guard."
##       - working: true
##         agent: "main"
##         comment: "Added explicit sign-in guard and disabled submit on /ads/create for signed-out sessions. Authenticated Ads tab browsing and real submit/list flows still need a signed-in test run."
##   - task: "Phone verify screen UI lockout fix"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/phone-verify.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "After OIDC sign-in on the native build, phone-verify screen was unclickable: country picker, phone input, and Send code button all disabled forever while Convex getCurrentUser/updateCurrentUser hung. UI was permanently stuck on Connecting your Smilers account..."
##       - working: true
##         agent: "main"
##         comment: "Removed meLoading/syncingUser gating from country picker, phone input, Send code, and Verify buttons (only submitting disables now). Replaced full-width connecting row with a small non-blocking pill. Added 12s safety timeout on background ensureUser effect so syncingUser cannot stay true forever. Rewrote ensureReadyForOtp to proactively sync inline when needed instead of bailing with Almost there. No changes to OIDC, Twilio, or any other auth file. Self-verified phone-verify renders with all inputs enabled in web preview."
##       - working: false
##         agent: "user"
##         comment: "Buttons now responsive, but tapping Send code returns CONVEX A(phoneAuthAction:sendOtp) Server Error / Called by client. Connecting your Smilers account pill keeps spinning. Hercules backend confirmed healthy by user."
##       - working: true
##         agent: "main"
##         comment: "Root cause identified in AuthProvider.getFreshIdToken: it returned accessToken first, falling back to idToken. Convex validates the ID token (JWT claims iss/sub) for ctx.auth.getUserIdentity(), not the access token. Sending the access token caused Convex to see the user as unauthenticated, which makes users.getCurrentUser hang and phoneAuthAction.sendOtp throw an empty Server Error. Fix: always return idToken from getFreshIdToken. No backend/Twilio changes needed."
##       - working: false
##         agent: "user"
##         comment: "After Twilio OTP verified successfully (token fix worked), app stuck on Opening Smilers... screen. Then later: shaking redirect loop between phone-verify and (tabs) screens."
##       - working: true
##         agent: "main"
##         comment: "Root cause from troubleshoot_agent: useSafeConvexQuery is one-shot (not reactive), so when verifyOtp updates the user record, the change does not propagate; new mounts get stale data, causing redirect loops. Fix: replaced useSafeConvexQuery with reactive useQuery(api.users.getCurrentUser) in BOTH phone-verify and tabs/_layout. Consolidated phone-verify into ONE redirect effect that trusts the local hasVerifiedInstall marker as authoritative and self-heals when server reports verified but marker missing. Removed redundant finalizingVerification state, removed duplicate router.replace effects. Tabs layout still has 10s safety timeout for the initial me query, and never bounces back to phone-verify if hasVerifiedInstall is true. App boots cleanly to Sign In in preview."
##   - task: "Contact crash fallback hardening"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/(tabs)/contacts.tsx"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported the app crashes instantly when opening the contact 'Asare Ben Chris'."
##       - working: true
##         agent: "main"
##         comment: "Hardened contacts and avatar name handling with safe display-name extraction, safer contact user-id lookup, and a guarded direct-chat opener so malformed contact records or non-string names no longer cause render/open failures."
##   - task: "Conversation display names show saved contact names"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/displayName.ts"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported chats and calls were showing 'Smilers' instead of the actual saved contact display names."
##       - working: true
##         agent: "main"
##         comment: "Added shared display-name resolution helpers and wired them into Chats, Contacts, Chat header, Call screen, add-to-call rows, and Avatar initials so the UI prefers the user's saved display name and gracefully handles odd data shapes."
##   - task: "Call screen overlap and outgoing ringtone polish"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/call/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported the contact name was overlapping call controls, and outgoing calls should play the caller's selected ringtone preference."
##       - working: true
##         agent: "main"
##         comment: "Reduced call-header text pressure, capped/scaled long contact names, tightened control spacing, and updated ringtone playback so the preferred ringtone plays during both incoming and outgoing ringing while vibration remains incoming-only."
##       - working: true
##         agent: "main"
##         comment: "After testing-agent feedback about compact-height overlap, reworked the non-video voice-call hero area into a centered content block, added compact-layout sizing/spacing for short mobile heights, and self-verified `/call/testconversation1?type=voice` at 375x667 with the status text no longer colliding with the control region."
##       - working: true
##         agent: "main"
##         comment: "Follow-up testing exposed a compact web-preview regression where `call-contact-name` rendered with zero height. Removed the single-line auto-clamp on the voice-call title, set explicit line-height sizing, and self-verified the compact 375x667 route now shows the caller/contact name visibly again."
##   - task: "Chat composer web-parity restyle"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "medium"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User said the composer box still did not visually match the web app."
##       - working: true
##         agent: "main"
##         comment: "Adjusted the composer shell, toolbar spacing, input shape, borders, and colors to move the chat composer closer to the latest web screenshot while preserving the rich-text tools added earlier."
##   - task: "Display-name crash recursion fix"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/displayName.ts"
##     stuck_count: 1
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported the specific contact 'Asare Ben Chris' still crashed when opened after the earlier safe-fallback patch."
##       - working: false
##         agent: "troubleshoot_agent"
##         comment: "Identified infinite recursion in normalizeDisplayText when circular conversation/user references are present."
##       - working: true
##         agent: "main"
##         comment: "Added WeakSet-based circular-reference protection plus a recursion-depth guard in the shared display-name formatter so malformed conversation/user objects do not stack-overflow the app."
##   - task: "Saved contact names from contacts fallback"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/call/[conversationId].tsx"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported that call/chat surfaces still sometimes showed the generic 'Smilers' label instead of the saved contact name."
##       - working: true
##         agent: "main"
##         comment: "Added contact-list fallback lookups so Chats, Chat header, and Call screen can resolve the locally saved contact display name even when the conversation payload itself is generic."
##   - task: "Composer dock gap removal and emoji expansion"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported a visible gap above the keyboard, wanted a more horizontal web-like composer, and wanted more than one emoji choice."
##       - working: true
##         agent: "main"
##         comment: "Moved the composer into a bottom dock with keyboard-aware safe-area padding, tightened the input row to be more horizontal, and replaced the single-tap emoji insert with a richer emoji picker sheet."
##   - task: "Automatic incoming-message translation"
##     implemented: true
##     working: true
##     file: "/app/backend/server.py"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User requested automatic translation into the receiver's preferred language, following the language-settings instructions."
##       - working: true
##         agent: "main"
##         comment: "Added a FastAPI `/api/translate` endpoint backed by Gemini 3 Flash through the Emergent key, plus frontend translation caching so incoming chat text can be auto-translated into the user's preferred language while respecting skip-language preferences."
##   - task: "Presence freshness and ringtone channel sync"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/(tabs)/_layout.tsx"
##     stuck_count: 0
##     priority: "medium"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User requested more realistic last-seen freshness and incoming-call ringtone behavior across app states."
##       - working: true
##         agent: "main"
##         comment: "Added foreground/background heartbeat presence sync, periodic conversation refresh for fresher last-seen labels, Android call-channel ringtone syncing to the selected ringtone, and bundled the ringtone assets in app config for notification-channel use."
##   - task: "Emoji categories and attachment-sheet web parity"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/components/EmojiPickerSheet.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User requested more emoji categories like the screenshots and asked for the attachment popup to match the web layout exactly."
##       - working: true
##         agent: "main"
##         comment: "Replaced the simple emoji modal with a fuller category-based emoji picker sheet and redesigned the attachment popup into a web-style floating action card with Photo, Video from Gallery, Record Video, Document, and Location actions."
##   - task: "Composer typing visibility and voice-note start fix"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported the composer still hid while typing and voice-note recording only showed the UI without actually starting."
##       - working: true
##         agent: "main"
##         comment: "Restored Android keyboard avoidance for the chat composer and replaced the voice-note start flow with a more reliable prepareToRecord/startAsync recording path so recording begins only after audio mode + recorder startup succeed."
##   - task: "Message alert sound and extra ringtone catalog"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/notification/useMessageNotificationSound.ts"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported the message ringtone was not rendering and the extra ringtones were still missing."
##       - working: true
##         agent: "main"
##         comment: "Switched foreground message alerts to a two-step playback sequence (beep + selected notification tone), added `Classic Ring` and `Smilers Notification` to the shared ringtone catalog, and expanded bundled sound declarations so the extra ringtone options now appear in settings."
##   - task: "Asare Ben Chris crash fix via translation-loop RCA"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 2
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported the Asare Ben Chris crash still persisted, with the screen looking shaky for a moment before Android closed the app."
##       - working: false
##         agent: "troubleshoot_agent"
##         comment: "Identified an infinite render loop in the chat auto-translation effect because translatedMessageMap was both a dependency and state updated by the same effect."
##       - working: true
##         agent: "main"
##         comment: "Removed translatedMessageMap from the effect dependency loop, added a ref to track already-translated message IDs, and clear that ref when conversationId changes so translated conversations no longer trigger runaway rerenders."
##   - task: "Split message-language vs languages-tab flows"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/languages.tsx"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User clarified that Message Language and Languages are different flows: Message Language is a single preferred-language picker for auto-translation, while Languages is the multi-select skip-translation list."
##       - working: true
##         agent: "main"
##         comment: "Split the flows by making `/message-language` the dedicated single-select preferred-language route and restoring `/languages` as the multi-select settings screen with search, default-language callout, and grouped checkbox rows."
##   - task: "Expanded official language catalog"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/languages.ts"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported only a tiny subset of languages was visible compared with the web app and asked for all recognised official languages, with distinct variants where the web separates them."
##       - working: true
##         agent: "main"
##         comment: "Expanded the shared language catalog to 111 entries, preserved distinct variants like Chinese Simplified/Traditional and Portuguese/Brazil, grouped UN official languages separately, and made the message-language picker show the full list by default instead of truncating to 16 items."
##   - task: "Notification sound simplification and faster translation"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/ringtones.tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User asked to keep only the customised message tone and Silent in notification sounds, and reported translation had become very slow or stalled."
##       - working: true
##         agent: "main"
##         comment: "Filtered notification-sound choices down to Smilers Notification + Silent, synced the Android messages channel to those choices, and sped up chat translation by translating only the newest pending messages in parallel instead of walking the entire visible list sequentially."
##   - task: "Voice-note audio-mode conflict fix"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/lib/notification/useMessageNotificationSound.ts"
##     stuck_count: 1
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported voice-note recording still showed the recording bar but did not truly work."
##       - working: false
##         agent: "troubleshoot_agent"
##         comment: "Identified a global audio-mode conflict: message notification playback was switching audio mode to allowsRecordingIOS=false and breaking later recording sessions."
##       - working: true
##         agent: "main"
##         comment: "Updated the notification-sound hook to keep recording-compatible audio mode so voice-note recording is no longer undermined by global message-sound playback."
##   - task: "Incoming notification channel hardening"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/push/usePushNotifications.ts"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported native notifications/ringing were the biggest blocker, especially for off-app and killed-state behavior, and wanted missed-call notifications too."
##       - working: true
##         agent: "main"
##         comment: "Hardened Android notification setup by adding POST_NOTIFICATIONS + full-screen-intent permissions in app config, syncing the Messages channel to the selected message sound, trimming the attachment sheet width, and scheduling a missed-call local notification when an incoming call ends unanswered while the app is alive enough to observe that transition."
##       - working: true
##         agent: "main"
##         comment: "After iteration 27, fixed two follow-up regressions: foreground message alerts now stay fully silent when Silent is selected (no forced beep first), and missed-call local notifications no longer fire after an answered call because incoming answered state is tracked separately from merely seeing the ringing state."
##       - working: true
##         agent: "main"
##         comment: "Aligned the push hook with the latest native mobile push spec: added `expo-task-manager` background notification task wiring, stronger `data.type` parsing, exact mobile-device registration payload `{ expoPushToken, platform, deviceName, appVersion }` with backend fallback between `api.mobilePush.registerMobileDevice` and `api.pushNotifications.registerMobileDevice`, Android `calls`/`messages` channel refresh with DND bypass + vibration, and iOS/Android config updates (`remote-notification`, `FOREGROUND_SERVICE_PHONE_CALL`). Preview boot was rechecked successfully after the dependency/install restart."
##       - working: true
##         agent: "main"
##         comment: "Backend confirmed the new `mobilePush` flow, so the hook is now mounted globally from `app/_layout.tsx` instead of the tabs layout, meaning native token registration starts as soon as an authenticated session exists — not only after the tabs screen mounts. Added best-effort unregister on logout plus native token-refresh re-registration, while keeping web preview isolated via `usePushNotifications.web.ts`."
##   - task: "Call name, hangup, and tools-button stability"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/call/[conversationId].tsx"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported that call screen still showed 'Smilers' instead of the saved receiver name, caller hangup still let the receiver continue ringing, and the red-circled composer tools button still backgrounded the app."
##       - working: false
##         agent: "troubleshoot_agent"
##         comment: "RCA: call route lacked an authoritative saved-name param for outgoing calls, and caller hangup during ringing should use declineCall rather than endCall. Separate RCA found requestAnimationFrame + TextInput.focus was the likely iOS backgrounding trigger for the tools button."
##       - working: true
##         agent: "main"
##         comment: "Chat now passes the resolved saved contact name into the call route, the call screen prioritizes that route name, caller hangup during ringing now uses declineCall, and the tools/sliders button now uses InteractionManager + delayed refocus instead of requestAnimationFrame. Local preview verified the call route shows 'Asare Ben Chris' and the tools button no longer crashes/breaks the chat route."
##   - task: "Presence subtitle source merge"
##     implemented: true
##     working: true
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "testing_agent"
##         comment: "Iteration 28 found that savedContactRecord could hide conversation presence fields, so online status might still not show even after prior subtitle fixes."
##       - working: true
##         agent: "main"
##         comment: "Merged saved-contact data with conversation presence fields before formatting the chat subtitle, so saved names and live online/last-seen data can coexist instead of overriding each other."
##   - task: "Delivery vs read tick separation"
##     implemented: true
##     working: true
##     file: "/app/frontend/src/push/usePushNotifications.ts"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported messages stay on one tick even when the receiver has internet and is inside the app; they only move to two ticks when the receiver opens that conversation."
##       - working: true
##         agent: "main"
##         comment: "Added separate delivery acknowledgements: `usePushNotifications` now calls `messages.markDelivered` when a message push is received while the app is running, and chat screen calls `markDelivered` before `markRead` when visible messages load. Also adjusted tick rendering to treat `readBy.length > 0` as read instead of requiring >1."
##       - working: true
##         agent: "testing_agent"
##         comment: "Iteration 30 confirmed the new code paths exist and the chat route stays stable, but true two-device delivery-vs-read validation still requires authenticated devices/accounts."
##   - task: "Deployment package/env stabilization"
##     implemented: true
##     working: true
##     file: "/app/frontend/package.json"
##     stuck_count: 0
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "Deployment logs showed two app-side/package-side issues before the final Gradle failure: `eslint-config-expo` was referenced but not reliably available during the build flow, and mobile auth still had a hardcoded `https://smilers.online` fallback instead of an environment-driven web app URL."
##       - working: false
##         agent: "deployment_agent"
##         comment: "Deployment RCA split the failure into code/package blockers vs a pure infrastructure blocker. Recommended repo-side fixes: remove mixed package-manager state, make eslint tooling reliably installable in the chosen package manager, and eliminate the hardcoded auth web URL fallback."
##       - working: true
##         agent: "main"
##         comment: "Switched the frontend package manager state fully to npm, removed yarn.lock, generated a consistent package-lock, moved `eslint` + `eslint-config-expo` into dependencies, verified `require('eslint-config-expo/flat')` works locally, and added `EXPO_PUBLIC_WEB_APP_URL` while removing the hardcoded `https://smilers.online` fallback from auth-webview/AuthProvider."
##   - task: "Voice note send multi-variant fallback + upload cleanup"
##     implemented: true
##     working: "NA"
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 2
##     priority: "critical"
##     needs_retesting: true
##     status_history:
##       - working: false
##         agent: "user"
##         comment: "User reported voice notes still fail to send. Alert shows '[CONVEX M(messages:send)] Server Error - Called by client'. Previous agent's fallback to api.ads.generateUploadUrl in uploadFile.ts was patching the wrong layer — the upload succeeds but messages:send mutation crashes on voice payload."
##       - working: "NA"
##         agent: "main"
##         comment: "Rewrote the voice note send flow with a 5-variant fallback: tries type='voice'+audioDuration first, then type='audio'+audioDuration, then voice without duration, then audio without duration, then finally type='file' with audio/m4a mime as last resort. Each attempt logs its label and payload, and the alert surfaces the actual server error (errorValue.data.message || .message) instead of generic 'Server Error'. Also reverted uploadFile.ts to only use api.files.generateUploadUrl (removed the bogus api.ads.generateUploadUrl fallback that was producing incompatible storageIds). Added clearer error capture at the upload-URL step too."
##   - task: "Expo projectId sync to installed APK"
##     implemented: true
##     working: "NA"
##     file: "/app/frontend/app.json"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: "NA"
##         agent: "main"
##         comment: "User's installed APK push diagnostics report projectId 8b742de6-a156-453c-8e54-16070577d2b7 but app.json had aff3eee0-0f42-475a-bd4c-a6d39d9b2f7b. Synced app.json to 8b742de6-... so future rebuilds stay consistent with the Emergent build pipeline's project. FCM credentials need to be uploaded to that project in expo.dev — this is a dashboard step, not code. Push code itself is correct; status is 'registered' with a valid Expo token."
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 3
##   run_ui: false
## test_plan:
##   current_focus:
##     - "Voice note send multi-variant fallback + upload cleanup"
##     - "Expo projectId sync to installed APK"
##   stuck_tasks:
##     - "Voice note send multi-variant fallback + upload cleanup"
##   test_all: false
##   test_priority: "high_first"
## agent_communication:
##   - agent: "main"
##     message: "Please test settings navigation plus /notifications, /earnings, /blocked, /emergency, /ai-chat, and one stub route like /chat-once. Missing Convex functions should now degrade gracefully instead of showing an error overlay."
##   - agent: "main"
##     message: "Testing-agent findings were addressed locally: push-notification web guards added, tab auth gate rewritten with Redirect, App Lock icon fixed, and notifications helper added for signed-out preview."
##   - agent: "main"
##     message: "Please test the new chat action implementation in app/chat/[conversationId].tsx as far as current credentials allow. If full auth/chat interaction is blocked, still validate that the app boots cleanly and report any route/runtime regressions introduced by the new screen code."
##   - agent: "main"
##     message: "Please test the Phase 2A.2a media additions as far as current credentials/platform allow. Full gallery/camera/image-upload validation likely requires a real authenticated mobile conversation; still validate app boot, route stability, and any new regressions in chat fallback behavior."
##   - agent: "main"
##     message: "Please validate the ads module as far as current auth allows: create/review routes, no preview regressions, and any obvious route/runtime issues from the new Ads tab wiring."
##   - agent: "main"
##     message: "Please validate /chat-appearance against the latest redesign: route should load without runtime errors, Wallpapers and Bubble Theme tabs should switch correctly, and the main layout should stay stable in preview."
##   - agent: "main"
##     message: "Testing-agent note for /chat-appearance was addressed locally: the back button touch target is now 46x46, and preview verification was repeated after the fix."
##   - agent: "main"
##     message: "Deployment logs showed the true Android build blocker in EAGER_BUNDLE: react-native-webrtc importing `event-target-shim/index`. I added a deploy-safe fix via npm override to event-target-shim@5.0.1 and a prepare hook so the local WebRTC patch still runs even if postinstall is overwritten during deployment."
##   - agent: "main"
##     message: "The next deployment log showed a different blocker during tarball upload: a corrupt filename in `/app/frontend`. I deleted the malformed file by inode and strengthened `.easignore` so similar junk names do not get archived again."
##   - agent: "main"
##     message: "User reported a native crash when opening the Groups tab. I hardened `/app/frontend/app/(tabs)/groups.tsx` by replacing raw Convex queries with `useSafeConvexQuery` and only enabling the optional conferences query when its sub-tab is active. Please validate route stability as far as auth allows."
##   - agent: "main"
##     message: "Please validate the latest navigation/crash fixes: Groups `+` should open `/groups-create`, Conferences `+` should open `/conference-create`, and `/call/[conversationId]` should no longer red-screen on route open for voice/video. Also confirm the Conferences tab itself stays stable." 
##   - agent: "main"
##     message: "Please validate `/trustees` against the new reference: main Trustees page should match the screenshot direction, Add Trustee should open a bottom sheet, the sheet should include a search box for name/phone, and only Smilers contacts from `api.contacts.getContacts` should appear as addable candidates." 
##   - agent: "main"
##     message: "Login and Sign Up were explicitly skipped by the user. The Message Language screen was rebuilt to mirror the latest screenshot with Akan (Asante Twi) included; testing confirmed the `Ak` search results and route stability." 
##   - agent: "main"
##     message: "Chat screenshots were applied to `/chat/[conversationId]` with the existing Chat Appearance system preserved. Please do one authenticated real-conversation check next to validate live message rendering on the new layout." 
##   - agent: "main"
##     message: "Latest chat extras and Send Money updates were applied from screenshots. Testing confirmed `/send-money` route stability and surfaced one disappearing-messages import bug, which was fixed and spot-verified locally."
##   - agent: "main"
##     message: "Android production call crash was investigated again using the user's APK symptom and a troubleshooting pass. I removed the remaining top-level `react-native-webrtc` imports from the native call modules and switched them to dynamic loading, which is the critical production-safe fix. The preview call route still renders after the refactor, but the APK must be rebuilt to confirm the native crash is gone."
##   - agent: "main"
##     message: "The subsequent deployment failure was a different blocker in `eas-update`: JSX inside `src/lib/webrtc/RTCViewWrapper.ts`. I replaced the JSX with `React.createElement(...)`, which keeps the file valid as `.ts` and is safer than renaming the file in this deployment flow."
##   - agent: "main"
##     message: "Please validate the latest user-reported chat/call/contact fixes. Priority order: 1) opening a real contact like 'Asare Ben Chris' should no longer crash, 2) chat and call headers should show the saved contact display name instead of the generic 'Smilers' fallback when data is available, 3) the voice-call screen should keep long names clear of the control buttons, 4) outgoing ringing should use the caller's selected ringtone preference, and 5) the chat composer should visually match the new tighter beige web-style box. Authenticated real-data checks are preferred if the Hercules flow is reachable; otherwise still verify route stability and flag any remaining runtime regressions." 
##   - agent: "main"
##     message: "Testing-agent reported one concrete UI regression on compact call screens. That is now addressed: the voice-call hero/status stack was restructured for short mobile heights and self-verified locally at 375x667 with no visual overlap into the control row. Remaining blocked checks still require authenticated real data and a native outgoing-call audio pass."
##   - agent: "main"
##     message: "New batch ready for validation: 1) circular-reference crash protection was added for the specific contact-open flow, 2) chat/call titles now try the saved Contacts data before falling back to conversation labels, 3) the composer now docks flush to the bottom with a richer emoji picker, 4) incoming text translation now goes through a new `/api/translate` backend endpoint using Gemini 3 Flash + the Emergent key and respects preferred/skip languages, and 5) presence + Android incoming-call notification channels now sync more aggressively for fresher last-seen and ringtone behavior. Authenticated device validation is still especially important for the real Asare Ben Chris contact, real saved-name parity, and native background/locked-call ringtone behavior." 
##   - agent: "main"
##     message: "Iteration 24's only concrete preview regression is fixed: the compact call-screen contact title is visible again after removing the problematic single-line auto-fit clamp and rechecking `/call/testconversation1?type=voice` at 375x667." 
##   - agent: "main"
##     message: "Latest user-requested chat polish is ready for validation: the emoji picker now has many more categories and a web-like category row, the attachment sheet now follows the floating web-card layout with the requested five actions, chat keyboard avoidance was restored to keep the composer visible while typing, voice-note startup now uses an explicit prepare/start recorder flow, and the ringtone catalog / message alert playback now include the extra sound options. Device validation is still especially important for actual recording, typing above the keyboard, and hearing the selected message/incoming-call sounds." 
##   - agent: "main"
##     message: "Latest regression + language batch is ready for validation: the Asare Ben Chris crash path now has a real RCA-backed fix for the translation render loop, `/message-language` now owns the single preferred-language picker, `/languages` is back to being the multi-select skip-translation list, and the shared language catalog now contains 111 official-language entries with distinct variants and grouped headings. Real signed-in validation is still required for the exact Asare Ben Chris conversation on device." 
##   - agent: "main"
##     message: "Latest audio/notification pass is ready for validation: the slider/tools button now immediately refocuses the message input, notification-sound choices are reduced to Smilers Notification + Silent, Android message/call channels now sync to the selected sounds, the attachment sheet is slimmer, missed-call local notifications are scheduled when an incoming call ends unanswered while the app can observe it, and translation now processes only the newest pending messages in parallel for much faster results. Killed-state ringing/notifications may still depend on native build permissions and the backend push payload actually targeting the native Expo token instead of web/Chrome notifications." 
##   - agent: "main"
##     message: "Iteration 27 found and the main agent fixed two regressions: Silent mode now suppresses the foreground beep entirely, and answered incoming calls no longer trigger a false missed-call notification. Translation endpoint also re-verified fast (~0.58s in local curl after the latest speed pass). The largest unresolved area remains true killed-state push/ringing, which likely requires the external Convex backend to send Expo mobile pushes to the native token instead of only web/Chrome push flows." 
##   - agent: "main"
##     message: "Iteration 28 validated the latest call/chat fixes: the call route now displays the passed saved contact name locally, the compact call layout kept the name and controls visible, the tools button no longer broke preview after the InteractionManager focus change, and translation API remained fast. One follow-up presence merge issue was fixed immediately after the report so saved contact names no longer mask online/last-seen fields." 
##   - agent: "main"
##     message: "Iteration 30 validated the new receipt code paths: chat now separates delivered vs read logic, the app acknowledges deliveries when message pushes arrive while running, and the chat route still renders gracefully in preview. The remaining risk is backend/runtime availability of `messages.markDelivered`, which still needs a real two-device signed-in test to prove sender ticks advance before the receiver opens the conversation." 
##   - agent: "main"
##     message: "Please validate the latest push-notification alignment work. Focus on `/app/frontend/src/push/usePushNotifications.ts` plus `app.json`: 1) app still boots without runtime regressions, 2) channels/categories/register payload logic match the new spec, 3) background task registration is safe, and 4) call/message notification routing still deep-links correctly from payload `data.type`. Real signed-in/native push delivery may still require physical-device validation because credentials are not available in this run." 
##   - agent: "main"
##     message: "Iteration 31 follow-up was fixed locally without a full retest: web preview had still been logging Expo push-token-listener warnings because web was bundling native notifications imports from non-hook files. Added a web stub for `usePushNotifications` and converted the call/ringtones notification imports to native-only lazy requires. Latest preview console no longer shows that warning." 
##   - agent: "main"
##     message: "After the backend mobile-push fix landed, the frontend was aligned again: `usePushNotifications` now runs from root layout, uses the `mobilePush` register/unregister lifecycle earlier in the auth flow, and no longer depends on the tabs route mounting before the device token reaches Convex. Web preview still boots successfully after this change." 
##   - agent: "main"
##     message: "Deployment hardening pass applied from the latest Emergent/EAS logs: moved `typescript` and `@babel/core` into runtime dependencies so production-style installs still satisfy Expo CLI checks, and added a committed `frontend/eas.json` with `cli.appVersionSource` plus the `app-bundle` profile so the deploy pipeline no longer has to synthesize that config ad hoc. Local validation now shows `npx expo install --check` and `npx expo-doctor` both pass cleanly. I did **not** keep `packageManager=npm` because this environment’s readonly supervisor is hardwired to Yarn for preview boot; that mismatch is local-only and not the blocker shown in your deployment log."
##   - agent: "main"
##     message: "Fixed the Android chat minimize/crash tied to the sliders/tools button in the composer. Root cause was a broken onPress handler in `app/chat/[conversationId].tsx` calling `setShowComposerFormatting(...)` even though no such state setter existed. Replaced it with a real `showComposerFormattingPinned` state and safe open/close behavior (focus on open, blur/dismiss on close). Testing agent iteration 33 confirmed the undefined-setter path is gone and repeated taps no longer crash the app shell in preview." 
##   - agent: "main"
##     message: "Push-registration hardening applied for the backend token issue: `usePushNotifications.ts` now waits for Convex auth readiness (`useConvexAuth`) before calling `api.mobilePush.registerMobileDevice`, retries failed registrations after 5 seconds, re-registers on app-active with a cached token, and keeps logout unregister + token-refresh registration guarded safely. Iteration 34 code review confirmed the previous early-registration race path is removed. Also fixed the follow-up Privacy route console noise in web preview by disabling cloud privacy sync on web and showing a native-app notice instead of hitting the missing/unstable backend query there." 
##   - agent: "main"
##     message: "Added an in-app push diagnostics panel on the Notifications screen so you can inspect native registration state directly on-device: registration status, auth session, Convex auth, projectId, permission, physical-device flag, token preview, last registration time, and last error. Also added a manual Retry button that is available only when native retry wiring exists; on web it now clearly shows `Native only`, and the diagnostics header layout was adjusted so it no longer clips on small screens. Testing agent iteration 35 validated the panel and the follow-up UI fixes were applied immediately after." 
##   - agent: "main"
##     message: "Added a one-tap `Copy diagnostics` button to the Notifications diagnostics card. It copies the full push-debug state (status, auth, Convex auth, projectId, permission, physical-device flag, full token, last registration time, last error, updated timestamp) so the user can paste it directly into chat without screenshots." 
##   - agent: "main"
##     message: "Used the copied diagnostics to pinpoint the remaining stall: the app was hanging indefinitely at Expo token acquisition. `usePushNotifications.ts` now splits that into two explicit stages — `acquiring-device-token` and `acquiring-expo-token` — and both are wrapped with 12-second timeouts. If Android stalls on native FCM token fetch, `Last error` will now say so directly instead of sitting forever on `acquiring-token`. Testing agent iteration 36 confirmed the staged statuses and timeout path are wired correctly." 
##   - agent: "main"
##     message: "The next copied diagnostics proved the blocker was the native Android token step itself. After the user provided Firebase Android config, I added `frontend/google-services.json` for project `smilers-a4e07` / package `com.smilers.app` and wired `expo.android.googleServicesFile` in `app.json`. Testing agent iteration 37 verified the file exists, the package names match, and Expo resolves the config correctly."
##   - agent: "main"
##     message: "After push registration started working (`Status: registered` with a real Expo token), I added two isolation tools to the Notifications diagnostics card: `Test local notification` and `Test remote self-push`. These help separate native rendering problems from backend delivery problems. Testing agent iteration 38 confirmed both buttons and their result rows render and update correctly." 
##   - agent: "main"
##     message: "Switched the app from the temporary Expo project link to the actual Expo project the user chose: `slug=smilers`, `owner=abcsimplesend`, `projectId=smilers-chat-mobile`. Testing agent iteration 40 confirmed both `app.json` and resolved Expo config now point to that project cleanly." 
##   - agent: "main"
##     message: "Fixed the chat GIF button doing nothing on Android. Root cause: `composer-toolbar-gif` in `app/chat/[conversationId].tsx` was intentionally rendered as a disabled button with no handler. It now opens a GIF-only picker using the existing document upload flow, validates `.gif` / `image/gif`, uploads as `image/gif`, and sends through the existing image message path. Testing agent iteration 41 confirmed the code path is wired correctly; authenticated on-device chat validation is still needed." 
##   - agent: "main"
##     message: "Investigated the 'old build' confusion: the evidence points to the phone still being tested with a binary produced before the later Expo project-link switch / credential alignment. Uninstalling the app only removes that binary from the device; it does not change what build artifact was originally generated by the deployment snapshot. Separately, I fixed the voice-note recorder path by migrating chat recording from deprecated `expo-av` recording APIs to `expo-audio`, adding the `expo-audio` plugin in `app.json`, and rewiring start/pause/resume/finish/cancel handlers. Testing agent iteration 42 validated the new code path and config; authenticated device recording/upload playback still needs real chat testing." 
##   - agent: "main"
##   - agent: "main"
##     message: "Iteration 43: Reverted previous agent's misdiagnosed uploadFile fallback (api.ads.generateUploadUrl was producing incompatible storageIds). Rewrote voice note send in app/chat/[conversationId].tsx with a 5-variant fallback chain (voice+dur, audio+dur, voice no-dur, audio no-dur, file) so the voice note gets through regardless of which exact payload shape the external Convex `messages:send` mutation accepts. Each attempt is logged with its label/payload and the alert now surfaces the actual server error string. Also synced app.json projectId to 8b742de6-a156-453c-8e54-16070577d2b7 to match the user's installed APK reported via Push Diagnostics. Please verify the FastAPI backend (/api/translate, /api/status, /api/) is healthy and that no regression was introduced in /app/backend/server.py. The Convex backend (messages:send, files.generateUploadUrl) is EXTERNAL (aware-newt-456.convex.cloud) and cannot be tested from this repo — only the FastAPI service in /app/backend can be tested here."
##   - agent: "testing"
##     message: "Iteration 43 FastAPI backend health check: ALL 8 backend tests PASSED against the public preview URL (https://smilers-chat-mobile.preview.emergentagent.com/api). Results: (1) GET /api/ returned 200 {\"message\":\"Hello World\"}. (2) POST /api/status created entry with id/client_name/timestamp and persisted to MongoDB. (3) GET /api/status returned the freshly created entry. (4A) POST /api/translate Spanish translation returned 'Hola, ¿cómo estás?' in ~1.5s. (4B) Empty text short-circuited to '' with no LLM call. (4C) Skip-language case preserved 'Hola amigo' unchanged when Spanish was in skip_languages. (4D) Cache hit returned identical translation in ~0.11s (vs 1.5s cold), confirming the in-memory TRANSLATION_CACHE works. (4E) Rich-text tags [b][/b] and [color=red][/color] were preserved while only translatable text was converted to French ('[b]Gras[/b] [color=red]Rouge[/color]'). Supervisor status: backend RUNNING (pid 201), mongodb RUNNING. No 5xx errors or stack traces in /var/log/supervisor/backend.err.log — only the normal uvicorn startup banners. Env loaded cleanly: MONGO_URL, DB_NAME, and EMERGENT_LLM_KEY are all present and functional (Gemini 3 Flash via EMERGENT_LLM_KEY is responding correctly). The two current_focus tasks (voice note send + Expo projectId sync) are FRONTEND-only and correctly marked NA for backend testing — no /app/backend changes were involved. Overall FastAPI backend verdict: HEALTHY, no regressions introduced."
##
## backend:
##   - task: "FastAPI health endpoints (GET /api/, /api/status CRUD)"
##     implemented: true
##     working: true
##     file: "/app/backend/server.py"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "testing"
##         comment: "Iteration 43 verification: GET /api/ returns 200 {\"message\":\"Hello World\"}. POST /api/status with {\"client_name\":\"test-iter-43\"} returns 200 with id (uuid), client_name, timestamp; entry persists in MongoDB and is returned by GET /api/status. Supervisor backend RUNNING, no errors in backend.err.log."
##   - task: "FastAPI /api/translate (Gemini 3 Flash via EMERGENT_LLM_KEY)"
##     implemented: true
##     working: true
##     file: "/app/backend/server.py"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: true
##         agent: "testing"
##         comment: "Iteration 43 verification of /api/translate covered all 5 sub-cases: (A) Spanish normal → 'Hola, ¿cómo estás?' in ~1.5s. (B) Empty text short-circuits to '' without an LLM call. (C) Skip-language preserved 'Hola amigo' unchanged when Spanish was in skip_languages. (D) Cache hit returned identical result in ~0.11s vs ~1.5s cold — TRANSLATION_CACHE works. (E) Rich-text tags [b][/b] and [color=red][/color] preserved while body translated to French ('[b]Gras[/b] [color=red]Rouge[/color]'). EMERGENT_LLM_KEY is loaded from /app/backend/.env, Gemini model 'gemini-3-flash-preview' responds correctly."
##   - task: "Voice note send multi-variant fallback + upload cleanup (FastAPI backend impact)"
##     implemented: true
##     working: "NA"
##     file: "/app/frontend/app/chat/[conversationId].tsx"
##     stuck_count: 2
##     priority: "critical"
##     needs_retesting: false
##     status_history:
##       - working: "NA"
##         agent: "testing"
##         comment: "NA for backend testing — this task only modifies frontend code in /app/frontend. The voice-note send flow targets the EXTERNAL Convex backend (aware-newt-456.convex.cloud, messages:send mutation), which is out of scope for this repo. FastAPI backend at /app/backend/server.py is unaffected and confirmed healthy."
##   - task: "Expo projectId sync to installed APK (FastAPI backend impact)"
##     implemented: true
##     working: "NA"
##     file: "/app/frontend/app.json"
##     stuck_count: 0
##     priority: "high"
##     needs_retesting: false
##     status_history:
##       - working: "NA"
##         agent: "testing"
##         comment: "NA for backend testing — projectId change in app.json is a frontend-only config switch for the Expo push pipeline and does not touch /app/backend/server.py. FastAPI backend remains healthy."

##     message: "Deployment log analysis isolated the final Android build failure as a remote Gradle download 502 in the EAS worker, but the repo-side blockers before that were still worth fixing. Package manager state is now consistently npm-based, eslint tooling is in runtime dependencies, and auth web URL resolution is env-driven instead of hardcoded to smilers.online."