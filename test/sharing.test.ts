import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readSharing,
  writeSharing,
  resolvePermission,
  getAllowedScopes,
  getAskScopes,
  getBlockedScopes,
  setProfile,
  setPermission,
  setContactOverride,
  removeContactOverride,
  formatScopeList,
  PROFILE_PERMISSIONS,
  ALL_SCOPES,
} from "../src/sharing.js";
import type { SharingConfig } from "../src/sharing.js";

const TEST_DIR = path.join(os.tmpdir(), `agentlink-test-sharing-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readSharing / writeSharing
// ---------------------------------------------------------------------------

describe("readSharing", () => {
  it("returns open profile defaults when file is missing", () => {
    const sharing = readSharing(TEST_DIR);
    expect(sharing.version).toBe(1);
    expect(sharing.profile).toBe("open");
    expect(sharing.permissions).toEqual(PROFILE_PERMISSIONS.open);
  });

  it("reads existing sharing.json", () => {
    const config: SharingConfig = {
      version: 1,
      profile: "private",
      permissions: { ...PROFILE_PERMISSIONS.private },
    };
    fs.writeFileSync(path.join(TEST_DIR, "sharing.json"), JSON.stringify(config));
    const sharing = readSharing(TEST_DIR);
    expect(sharing.profile).toBe("private");
    expect(sharing.permissions["financial"]).toBe("block");
  });
});

describe("writeSharing", () => {
  it("writes and round-trips correctly", () => {
    const config: SharingConfig = {
      version: 1,
      profile: "balanced",
      permissions: { ...PROFILE_PERMISSIONS.balanced },
      contacts: {
        "cersei-1234": {
          name: "cersei",
          human_name: "Catherine Safaya",
          overrides: { "location.precise": "allow" },
        },
      },
    };
    writeSharing(TEST_DIR, config);
    const read = readSharing(TEST_DIR);
    expect(read.profile).toBe("balanced");
    expect(read.contacts?.["cersei-1234"]?.overrides["location.precise"]).toBe("allow");
  });

  it("creates directory if missing", () => {
    const nested = path.join(TEST_DIR, "sub", "dir");
    const config: SharingConfig = { version: 1, profile: "open", permissions: {} };
    writeSharing(nested, config);
    expect(fs.existsSync(path.join(nested, "sharing.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePermission
// ---------------------------------------------------------------------------

describe("resolvePermission", () => {
  const sharing: SharingConfig = {
    version: 1,
    profile: "open",
    permissions: { ...PROFILE_PERMISSIONS.open },
    contacts: {
      "cersei-1234": {
        name: "cersei",
        human_name: "Catherine Safaya",
        overrides: {
          "location.precise": "allow",
          "financial": "allow",
        },
      },
    },
  };

  it("returns base permission when no contact specified", () => {
    expect(resolvePermission(sharing, "calendar.read")).toBe("allow");
    expect(resolvePermission(sharing, "financial")).toBe("block");
    expect(resolvePermission(sharing, "location.precise")).toBe("ask");
  });

  it("returns base permission when contact has no override for scope", () => {
    expect(resolvePermission(sharing, "calendar.read", "cersei-1234")).toBe("allow");
    expect(resolvePermission(sharing, "health", "cersei-1234")).toBe("block");
  });

  it("returns contact override when present", () => {
    expect(resolvePermission(sharing, "location.precise", "cersei-1234")).toBe("allow");
    expect(resolvePermission(sharing, "financial", "cersei-1234")).toBe("allow");
  });

  it("returns block for unknown scopes", () => {
    expect(resolvePermission(sharing, "nonexistent")).toBe("block");
  });

  it("returns base permission for unknown contacts", () => {
    expect(resolvePermission(sharing, "financial", "unknown-9999")).toBe("block");
    expect(resolvePermission(sharing, "calendar.read", "unknown-9999")).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// getAllowedScopes / getAskScopes / getBlockedScopes
// ---------------------------------------------------------------------------

describe("scope listing", () => {
  it("returns correct scopes for open profile", () => {
    const sharing = readSharing(TEST_DIR); // defaults to open
    const allowed = getAllowedScopes(sharing);
    const ask = getAskScopes(sharing);
    const blocked = getBlockedScopes(sharing);

    expect(allowed).toContain("calendar.read");
    expect(allowed).toContain("preferences");
    expect(ask).toContain("calendar.write");
    expect(ask).toContain("location.precise");
    expect(blocked).toContain("financial");
    expect(blocked).toContain("health");

    // Every scope accounted for
    expect(allowed.length + ask.length + blocked.length).toBe(ALL_SCOPES.length);
  });

  it("respects contact overrides in scope listing", () => {
    const sharing: SharingConfig = {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
      contacts: {
        "cersei-1234": {
          name: "cersei",
          human_name: "Catherine",
          overrides: { "financial": "allow", "location.precise": "allow" },
        },
      },
    };

    const allowed = getAllowedScopes(sharing, "cersei-1234");
    const blocked = getBlockedScopes(sharing, "cersei-1234");

    expect(allowed).toContain("financial");
    expect(allowed).toContain("location.precise");
    expect(blocked).not.toContain("financial");
  });
});

// ---------------------------------------------------------------------------
// setProfile
// ---------------------------------------------------------------------------

describe("setProfile", () => {
  it("resets permissions to profile defaults", () => {
    // Start with open, switch to private
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
    });
    setProfile(TEST_DIR, "private");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.profile).toBe("private");
    expect(sharing.permissions["calendar.read"]).toBe("ask");
    expect(sharing.permissions["calendar.write"]).toBe("block");
  });

  it("preserves contacts when switching profile", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
      contacts: {
        "cersei-1234": {
          name: "cersei",
          human_name: "Catherine",
          overrides: { "financial": "allow" },
        },
      },
    });
    setProfile(TEST_DIR, "balanced");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.contacts?.["cersei-1234"]?.overrides["financial"]).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// setPermission
// ---------------------------------------------------------------------------

describe("setPermission", () => {
  it("updates a base permission", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
    });
    setPermission(TEST_DIR, "financial", "allow");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.permissions["financial"]).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// setContactOverride / removeContactOverride
// ---------------------------------------------------------------------------

describe("setContactOverride", () => {
  it("creates contact entry and sets override", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
    });
    setContactOverride(TEST_DIR, "cersei-1234", "cersei", "Catherine", "financial", "allow");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.contacts?.["cersei-1234"]?.name).toBe("cersei");
    expect(sharing.contacts?.["cersei-1234"]?.human_name).toBe("Catherine");
    expect(sharing.contacts?.["cersei-1234"]?.overrides["financial"]).toBe("allow");
  });

  it("adds override to existing contact", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
      contacts: {
        "cersei-1234": {
          name: "cersei",
          human_name: "Catherine",
          overrides: { "financial": "allow" },
        },
      },
    });
    setContactOverride(TEST_DIR, "cersei-1234", "cersei", "Catherine", "health", "allow");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.contacts?.["cersei-1234"]?.overrides["financial"]).toBe("allow");
    expect(sharing.contacts?.["cersei-1234"]?.overrides["health"]).toBe("allow");
  });
});

describe("removeContactOverride", () => {
  it("removes a specific override", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
      contacts: {
        "cersei-1234": {
          name: "cersei",
          human_name: "Catherine",
          overrides: { "financial": "allow", "health": "allow" },
        },
      },
    });
    removeContactOverride(TEST_DIR, "cersei-1234", "financial");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.contacts?.["cersei-1234"]?.overrides["financial"]).toBeUndefined();
    expect(sharing.contacts?.["cersei-1234"]?.overrides["health"]).toBe("allow");
  });

  it("removes contact entry when last override is removed", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
      contacts: {
        "cersei-1234": {
          name: "cersei",
          human_name: "Catherine",
          overrides: { "financial": "allow" },
        },
      },
    });
    removeContactOverride(TEST_DIR, "cersei-1234", "financial");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.contacts?.["cersei-1234"]).toBeUndefined();
  });

  it("is a no-op for unknown contact", () => {
    writeSharing(TEST_DIR, {
      version: 1,
      profile: "open",
      permissions: { ...PROFILE_PERMISSIONS.open },
    });
    // Should not throw
    removeContactOverride(TEST_DIR, "unknown-9999", "financial");
    const sharing = readSharing(TEST_DIR);
    expect(sharing.contacts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatScopeList
// ---------------------------------------------------------------------------

describe("formatScopeList", () => {
  it("formats scopes with human-readable labels", () => {
    const result = formatScopeList(["calendar.read", "financial"]);
    expect(result).toBe("calendar (read), financial info (bank, salary)");
  });

  it("falls back to raw scope name for unknown scopes", () => {
    const result = formatScopeList(["custom.scope"]);
    expect(result).toBe("custom.scope");
  });
});
