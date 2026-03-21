import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SharingProfile = "open" | "balanced" | "private";
export type PermissionAction = "allow" | "ask" | "block";

export interface ContactOverride {
  name: string;
  human_name: string;
  overrides: Record<string, PermissionAction>;
}

export interface SharingConfig {
  version: number;
  profile: SharingProfile;
  permissions: Record<string, PermissionAction>;
  contacts?: Record<string, ContactOverride>;
}

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

export const ALL_SCOPES = [
  "calendar.read",
  "calendar.write",
  "location.general",
  "location.precise",
  "contacts.names",
  "contacts.details",
  "preferences",
  "work.context",
  "work.files",
  "communication.history",
  "financial",
  "health",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

// Human-readable labels for prompt injection
export const SCOPE_LABELS: Record<string, string> = {
  "calendar.read": "calendar (read)",
  "calendar.write": "calendar (write)",
  "location.general": "general location (city/area)",
  "location.precise": "precise location (home address)",
  "contacts.names": "contact names",
  "contacts.details": "contact details (phone, email)",
  "preferences": "preferences (dietary, travel, favorites)",
  "work.context": "work context (projects, topics)",
  "work.files": "work files",
  "communication.history": "communication history (chat logs)",
  "financial": "financial info (bank, salary)",
  "health": "health info (medical, appointments)",
};

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

const OPEN_PERMISSIONS: Record<string, PermissionAction> = {
  "calendar.read": "allow",
  "calendar.write": "ask",
  "location.general": "allow",
  "location.precise": "ask",
  "contacts.names": "allow",
  "contacts.details": "ask",
  "preferences": "allow",
  "work.context": "allow",
  "work.files": "ask",
  "communication.history": "ask",
  "financial": "block",
  "health": "block",
};

const BALANCED_PERMISSIONS: Record<string, PermissionAction> = {
  "calendar.read": "allow",
  "calendar.write": "ask",
  "location.general": "allow",
  "location.precise": "ask",
  "contacts.names": "allow",
  "contacts.details": "ask",
  "preferences": "allow",
  "work.context": "allow",
  "work.files": "ask",
  "communication.history": "block",
  "financial": "block",
  "health": "block",
};

const PRIVATE_PERMISSIONS: Record<string, PermissionAction> = {
  "calendar.read": "ask",
  "calendar.write": "block",
  "location.general": "ask",
  "location.precise": "block",
  "contacts.names": "ask",
  "contacts.details": "block",
  "preferences": "allow",
  "work.context": "ask",
  "work.files": "block",
  "communication.history": "block",
  "financial": "block",
  "health": "block",
};

export const PROFILE_PERMISSIONS: Record<SharingProfile, Record<string, PermissionAction>> = {
  open: OPEN_PERMISSIONS,
  balanced: BALANCED_PERMISSIONS,
  private: PRIVATE_PERMISSIONS,
};

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const SHARING_FILE = "sharing.json";

function sharingPath(dataDir: string): string {
  return path.join(dataDir, SHARING_FILE);
}

/**
 * Read sharing config from disk. Returns open-profile defaults if file is missing.
 */
export function readSharing(dataDir: string): SharingConfig {
  try {
    const raw = fs.readFileSync(sharingPath(dataDir), "utf-8");
    return JSON.parse(raw) as SharingConfig;
  } catch {
    return {
      version: 1,
      profile: "open",
      permissions: { ...OPEN_PERMISSIONS },
    };
  }
}

/**
 * Write sharing config to disk (atomic: write tmp, rename).
 */
export function writeSharing(dataDir: string, sharing: SharingConfig): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const dest = sharingPath(dataDir);
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sharing, null, 2));
  fs.renameSync(tmp, dest);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective permission for a scope + optional contact.
 * Resolution order: contact override > base permission > "block" (default).
 */
export function resolvePermission(
  sharing: SharingConfig,
  scope: string,
  contactAgentId?: string,
): PermissionAction {
  // 1. Contact override
  if (contactAgentId && sharing.contacts?.[contactAgentId]) {
    const override = sharing.contacts[contactAgentId].overrides[scope];
    if (override) return override;
  }
  // 2. Base permission
  if (sharing.permissions[scope]) {
    return sharing.permissions[scope];
  }
  // 3. Default
  return "block";
}

/**
 * Get all scopes that resolve to a given action for a contact.
 */
function scopesByAction(
  sharing: SharingConfig,
  action: PermissionAction,
  contactAgentId?: string,
): string[] {
  return ALL_SCOPES.filter(
    (scope) => resolvePermission(sharing, scope, contactAgentId) === action,
  );
}

export function getAllowedScopes(sharing: SharingConfig, contactAgentId?: string): string[] {
  return scopesByAction(sharing, "allow", contactAgentId);
}

export function getAskScopes(sharing: SharingConfig, contactAgentId?: string): string[] {
  return scopesByAction(sharing, "ask", contactAgentId);
}

export function getBlockedScopes(sharing: SharingConfig, contactAgentId?: string): string[] {
  return scopesByAction(sharing, "block", contactAgentId);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Reset sharing config to a profile's defaults. Preserves contacts.
 */
export function setProfile(dataDir: string, profile: SharingProfile): void {
  const existing = readSharing(dataDir);
  existing.profile = profile;
  existing.permissions = { ...PROFILE_PERMISSIONS[profile] };
  writeSharing(dataDir, existing);
}

/**
 * Set a base permission for a scope.
 */
export function setPermission(dataDir: string, scope: string, action: PermissionAction): void {
  const sharing = readSharing(dataDir);
  sharing.permissions[scope] = action;
  writeSharing(dataDir, sharing);
}

/**
 * Set a per-contact override for a scope.
 */
export function setContactOverride(
  dataDir: string,
  agentId: string,
  name: string,
  humanName: string,
  scope: string,
  action: PermissionAction,
): void {
  const sharing = readSharing(dataDir);
  if (!sharing.contacts) sharing.contacts = {};
  if (!sharing.contacts[agentId]) {
    sharing.contacts[agentId] = { name, human_name: humanName, overrides: {} };
  }
  sharing.contacts[agentId].overrides[scope] = action;
  writeSharing(dataDir, sharing);
}

/**
 * Remove a per-contact override for a scope.
 */
export function removeContactOverride(
  dataDir: string,
  agentId: string,
  scope: string,
): void {
  const sharing = readSharing(dataDir);
  if (!sharing.contacts?.[agentId]) return;
  delete sharing.contacts[agentId].overrides[scope];
  // Clean up empty overrides
  if (Object.keys(sharing.contacts[agentId].overrides).length === 0) {
    delete sharing.contacts[agentId];
  }
  writeSharing(dataDir, sharing);
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Format scope names as human-readable labels for prompt injection.
 */
export function formatScopeList(scopes: string[]): string {
  return scopes.map((s) => SCOPE_LABELS[s] || s).join(", ");
}
