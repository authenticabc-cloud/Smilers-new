import { anyApi } from 'convex/server';

// Convex backend API references. We use anyApi since the backend's
// generated types live in the web app's codebase, not this mobile app.
// All function paths below match the existing Smilers Convex backend.
export const api: any = anyApi;
