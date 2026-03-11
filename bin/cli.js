#!/usr/bin/env node

/**
 * AgentLink CLI
 *
 * npx @agentlinkdev/agentlink setup          — Install plugin + generate identity
 * npx @agentlinkdev/agentlink setup --join CODE — Install + join via invite code
 * npx @agentlinkdev/agentlink uninstall       — Remove plugin (preserves identity)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import pc from "picocolors";
import ora from "ora";

const DATA_DIR = path.join(os.homedir(), ".agentlink");
const IDENTITY_FILE = path.join(DATA_DIR, "identity.json");
const OC_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

const ID_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSuffix(len = 4) {
  return Array.from({ length: len }, () =>
    ID_CHARSET[Math.floor(Math.random() * ID_CHARSET.length)]
  ).join("");
}

function slugify(name) {
  // Normalize Unicode (e.g., Š → S)
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "agent";
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function box(lines) {
  const maxLen = Math.max(...lines.map(l => l.length));
  const border = "─".repeat(maxLen + 4);
  console.log(`\n╭${border}╮`);
  lines.forEach(line => {
    const padding = " ".repeat(maxLen - line.length);
    console.log(`│  ${line}${padding}  │`);
  });
  console.log(`╰${border}╯\n`);
}

function detectIdentity() {
  // 1. Check existing identity.json
  if (fs.existsSync(IDENTITY_FILE)) {
    try {
      const identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8"));
      if (identity.agent_id && identity.human_name) {
        return { existing: true, ...identity };
      }
    } catch {}
  }

  // 2. Check OpenClaw plugin config
  if (fs.existsSync(OC_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
      const agentConfig = config?.plugins?.entries?.agentlink?.config?.agent;
      if (agentConfig?.human_name) {
        return { detectedFrom: "openclaw.json", name: agentConfig.human_name };
      }
    } catch {}
  }

  // 3. Try USER.md (skip if template)
  const userMdPath = path.join(os.homedir(), ".openclaw", "workspace", "USER.md");
  if (fs.existsSync(userMdPath)) {
    try {
      const content = fs.readFileSync(userMdPath, "utf-8");
      // Look for "- **Name:** VALUE" pattern
      const nameMatch = content.match(/^-\s*\*\*Name:\*\*\s+(.+)$/m);
      if (nameMatch && nameMatch[1].trim()) {
        const name = nameMatch[1].trim();
        // Skip if it's empty, has underscores (template marker), or is a label
        if (name.length > 0 && !name.includes("_") && !name.includes("**") && !name.includes(":")) {
          return { detectedFrom: "USER.md", name };
        }
      }
    } catch {}
  }

  // 4. Fall back to system username
  const username = os.userInfo().username;
  if (username && username !== "root") {
    return { detectedFrom: "system", name: username };
  }

  return null;
}

async function setup(joinCode) {
  console.log("\n" + pc.bold("  AgentLink Setup") + "\n");

  // Step 1: Check for OpenClaw
  const spinner1 = ora("Checking for OpenClaw...").start();
  let ocPath;
  try {
    ocPath = execSync("which openclaw", { stdio: "pipe", encoding: "utf-8" }).trim();
    spinner1.succeed(`OpenClaw found: ${pc.dim(ocPath)}`);
  } catch {
    spinner1.fail("OpenClaw not found");
    console.error(pc.red("\n  Error: 'openclaw' CLI not found on PATH."));
    console.error(pc.dim("  Install OpenClaw first: https://openclaw.ai\n"));
    process.exit(1);
  }

  // Step 2: Check/generate identity
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const detected = detectIdentity();
  let identity;

  if (detected?.existing) {
    console.log(pc.green(`  ✓ Existing identity: ${detected.agent_id} (${detected.human_name})`));
    identity = detected;
  } else {
    // Ask for name with auto-detected default
    let name;
    if (detected?.name) {
      console.log(pc.dim(`\n  Detected from ${detected.detectedFrom}: ${pc.bold(detected.name)}`));
      const answer = await ask(`  Your name (press Enter to confirm, or type to change): `);
      name = answer || detected.name;
    } else {
      name = await ask("  What's your name? ");
    }

    if (!name) {
      console.error(pc.red("  Name is required.\n"));
      process.exit(1);
    }

    const agentId = `${slugify(name)}-${generateSuffix()}`;
    identity = { agent_id: agentId, human_name: name };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + "\n");
    console.log(pc.green(`  ✓ Agent ID: ${agentId}`));
  }

  // Step 3: Install plugin with proper permission dance
  const spinner2 = ora("Installing AgentLink plugin...").start();

  try {
    // Read config
    let config = {};
    if (fs.existsSync(OC_CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
    }

    // Save current plugins.allow (if exists)
    const hadPluginsAllow = config.plugins?.allow;

    // Temporarily remove plugins.allow to avoid chicken-and-egg
    if (config.plugins?.allow) {
      delete config.plugins.allow;
      fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2));
    }

    // Install plugin
    try {
      execSync("openclaw plugins install @agentlinkdev/agentlink", {
        stdio: "pipe",
        encoding: "utf-8"
      });
    } catch (installErr) {
      // Restore plugins.allow before failing
      if (hadPluginsAllow && fs.existsSync(OC_CONFIG_PATH)) {
        const restoreConfig = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
        if (!restoreConfig.plugins) restoreConfig.plugins = {};
        restoreConfig.plugins.allow = hadPluginsAllow;
        fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(restoreConfig, null, 2));
      }
      throw installErr;
    }

    // Re-read config (plugin install may have modified it)
    config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));

    // Re-add plugins.allow
    if (!config.plugins) config.plugins = {};
    config.plugins.allow = ["agentlink"];

    // Add tools.alsoAllow (CRITICAL: not tools.allow)
    if (!config.tools) config.tools = {};
    if (!config.tools.alsoAllow) config.tools.alsoAllow = [];
    if (!config.tools.alsoAllow.includes("agentlink")) {
      config.tools.alsoAllow.push("agentlink");
    }

    fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2));
    spinner2.succeed("Plugin installed");
    console.log(pc.green("  ✓ Permissions configured"));
  } catch (err) {
    spinner2.fail("Plugin installation failed");
    console.error(pc.red("\n  Error during plugin install:"));
    console.error(pc.dim(`  ${err.message}\n`));
    process.exit(1);
  }

  // Step 4: Handle invite code (if provided)
  if (joinCode) {
    const pendingFile = path.join(DATA_DIR, "pending_join.json");
    fs.writeFileSync(pendingFile, JSON.stringify({ code: joinCode }) + "\n");
    console.log(pc.green(`  ✓ Invite code ${joinCode} will be processed on gateway start`));
  }

  // Step 5: Success!
  console.log(pc.green("\n  ✓ Setup complete!\n"));
  console.log(pc.dim(`  Agent ID: ${identity.agent_id}`));
  console.log(pc.dim(`  Data dir: ${DATA_DIR}\n`));

  // Viral loop prompt
  if (joinCode) {
    box([
      pc.bold(`Connected with invite code ${joinCode}!`),
      "",
      "Try messaging the inviter:",
      pc.cyan(`"Message them: hey, just set up AgentLink!"`),
    ]);
  } else {
    box([
      pc.bold("You're connected!"),
      "",
      "Tell your agent to try it:",
      pc.cyan(`"Generate an AgentLink invite for [Name]"`),
    ]);
  }

  // Gateway restart instructions
  console.log(pc.yellow("  Restart your gateway to activate AgentLink:"));
  console.log(pc.bold("    openclaw gateway stop && openclaw gateway\n"));
}

function uninstall() {
  console.log("\n" + pc.bold("  AgentLink Uninstall") + "\n");

  const spinner = ora("Removing plugin...").start();
  try {
    execSync("openclaw plugins uninstall @agentlinkdev/agentlink", { stdio: "pipe" });
    spinner.succeed("Plugin removed");
  } catch {
    spinner.warn("Plugin may already be uninstalled");
  }

  console.log(pc.green(`\n  ✓ Plugin removed. Identity preserved in ${DATA_DIR}`));
  console.log(pc.dim(`  To fully remove: rm -rf ${DATA_DIR}\n`));
}

// --- Main ---
const args = process.argv.slice(2);
const command = args[0];

if (command === "setup") {
  const joinIdx = args.indexOf("--join");
  const joinCode = joinIdx >= 0 ? args[joinIdx + 1] : undefined;
  setup(joinCode);
} else if (command === "uninstall") {
  uninstall();
} else {
  console.log("\n" + pc.bold("  AgentLink CLI") + "\n");
  console.log("  Usage:");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup") + "              Install + generate identity");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup --join CODE") + "  Install + join via invite");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink uninstall") + "          Remove plugin\n");
}
