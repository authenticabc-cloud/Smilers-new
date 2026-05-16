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
##     needs_retesting: true
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
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 2
##   run_ui: true
## test_plan:
##   current_focus:
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