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
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 2
##   run_ui: true
## test_plan:
##   current_focus:
##     - "Display-name crash recursion fix"
##     - "Saved contact names from contacts fallback"
##     - "Composer dock gap removal and emoji expansion"
##     - "Automatic incoming-message translation"
##     - "Presence freshness and ringtone channel sync"
##     - "Contact crash fallback hardening"
##     - "Conversation display names show saved contact names"
##     - "Call screen overlap and outgoing ringtone polish"
##     - "Chat composer web-parity restyle"
##     - "Phase 1 utility screens and settings navigation"
##     - "Chat appearance screenshot redesign"
##     - "Android EAS WebRTC bundle fix"
##     - "Android EAS tarball corruption cleanup"
##     - "Groups tab native crash fix"
##     - "Groups plus / conferences plus / call route crash fixes"
##     - "Trustees page screenshot redesign"
##     - "Message language screenshot redesign"
##     - "Chat screen screenshot restyle"
##     - "Chat voice-note controls + disappearing messages + send money redesign"
##     - "Android production call crash RCA and WebRTC import refactor"
##     - "EAS update export syntax fix for RTCView wrapper"
##     - "Web-safe tabs and push notification hooks"
##     - "Phase 2A.1 chat actions"
##     - "Phase 2A.2a image attachments"
##     - "Ads module MVP"
##   stuck_tasks: []
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