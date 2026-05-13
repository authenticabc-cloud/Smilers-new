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
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 2
##   run_ui: true
## test_plan:
##   current_focus:
##     - "Phase 1 utility screens and settings navigation"
##     - "Web-safe tabs and push notification hooks"
##     - "Phase 2A.1 chat actions"
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