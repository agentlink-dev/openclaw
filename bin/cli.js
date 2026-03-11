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
      if (identity.agent_id && identity.human_name && identity.agent_name) {
        return { existing: true, ...identity };
      }
    } catch {}
  }

  // 2. Check OpenClaw plugin config
  let humanName = null;
  let agentName = null;

  if (fs.existsSync(OC_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, "utf-8"));
      const agentConfig = config?.plugins?.entries?.agentlink?.config?.agent;
      if (agentConfig?.human_name) {
        humanName = agentConfig.human_name;
      }
    } catch {}
  }

  // 3. Try USER.md for human name (skip if template)
  const userMdPath = path.join(os.homedir(), ".openclaw", "workspace", "USER.md");
  if (!humanName && fs.existsSync(userMdPath)) {
    try {
      const content = fs.readFileSync(userMdPath, "utf-8");
      const nameMatch = content.match(/^-\s*\*\*Name:\*\*\s+(.+)$/m);
      if (nameMatch && nameMatch[1].trim()) {
        const name = nameMatch[1].trim();
        if (name.length > 0 && !name.includes("_") && !name.includes("**") && !name.includes(":")) {
          humanName = name;
        }
      }
    } catch {}
  }

  // 4. Try IDENTITY.md for agent name
  const identityMdPath = path.join(os.homedir(), ".openclaw", "workspace", "IDENTITY.md");
  if (fs.existsSync(identityMdPath)) {
    try {
      const content = fs.readFileSync(identityMdPath, "utf-8");
      const nameMatch = content.match(/^-\s*\*\*Name:\*\*\s+(.+)$/m);
      if (nameMatch && nameMatch[1].trim()) {
        const name = nameMatch[1].trim();
        if (name.length > 0 && !name.includes("_") && !name.includes("**") && !name.includes(":")) {
          agentName = name;
        }
      }
    } catch {}
  }

  // 5. Try MEMORY.md as fallback for both names
  const memoryMdPath = path.join(os.homedir(), ".openclaw", "workspace", "MEMORY.md");
  if ((!humanName || !agentName) && fs.existsSync(memoryMdPath)) {
    try {
      const content = fs.readFileSync(memoryMdPath, "utf-8");

      // Look for "- Name: VALUE" (human name)
      if (!humanName) {
        const humanMatch = content.match(/^-\s*Name:\s+(.+)$/m);
        if (humanMatch && humanMatch[1].trim()) {
          humanName = humanMatch[1].trim();
        }
      }

      // Look for "I'm [AgentName]" pattern
      if (!agentName) {
        const agentMatch = content.match(/I'm\s+(\w+),/);
        if (agentMatch && agentMatch[1]) {
          agentName = agentMatch[1];
        }
      }
    } catch {}
  }

  // Determine sources
  let humanSource = null;
  let agentSource = null;

  if (humanName) {
    if (fs.existsSync(memoryMdPath)) {
      const memContent = fs.readFileSync(memoryMdPath, "utf-8");
      if (memContent.includes(`Name: ${humanName}`)) humanSource = "MEMORY.md";
    }
    if (!humanSource && fs.existsSync(userMdPath)) {
      const userContent = fs.readFileSync(userMdPath, "utf-8");
      if (userContent.includes(humanName)) humanSource = "USER.md";
    }
    if (!humanSource) humanSource = "openclaw.json";
  }

  if (agentName) {
    if (fs.existsSync(identityMdPath)) {
      const idContent = fs.readFileSync(identityMdPath, "utf-8");
      if (idContent.includes(agentName)) agentSource = "IDENTITY.md";
    }
    if (!agentSource && fs.existsSync(memoryMdPath)) {
      const memContent = fs.readFileSync(memoryMdPath, "utf-8");
      if (memContent.includes(`I'm ${agentName}`)) agentSource = "MEMORY.md";
    }
  }

  return {
    humanName: humanName || null,
    agentName: agentName || null,
    humanNameSource: humanSource,
    agentNameSource: agentSource,
  };
}

async function setup(joinCode, humanNameArg, agentNameArg) {
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
    console.log(pc.green(`  ✓ Existing identity: ${detected.agent_id} (${detected.agent_name} for ${detected.human_name})`));
    identity = detected;
  } else {
    let humanName;
    let agentName;

    // Check if CLI arguments were provided (non-interactive mode)
    const isNonInteractive = humanNameArg || agentNameArg || joinCode;

    if (isNonInteractive) {
      // Use CLI args, then detected values, then defaults
      humanName = humanNameArg || detected.humanName || os.userInfo().username || "User";
      agentName = agentNameArg || detected.agentName || "Agent";

      console.log(pc.dim(`  Auto-configuring...`));
      if (humanNameArg) {
        console.log(pc.dim(`  Human name: ${humanName} (from --human-name)`));
      } else if (detected.humanName) {
        console.log(pc.dim(`  Human name: ${humanName} (from ${detected.humanNameSource})`));
      } else {
        console.log(pc.dim(`  Human name: ${humanName} (using system username)`));
      }

      if (agentNameArg) {
        console.log(pc.dim(`  Agent name: ${agentName} (from --agent-name)`));
      } else if (detected.agentName) {
        console.log(pc.dim(`  Agent name: ${agentName} (from ${detected.agentNameSource})`));
      } else {
        console.log(pc.dim(`  Agent name: ${agentName} (using default)`));
      }
    } else {
      // Interactive mode - ask for confirmation/input
      if (detected.humanName) {
        console.log(pc.dim(`\n  Detected from ${detected.humanNameSource}: ${pc.bold(detected.humanName)}`));
        const answer = await ask(`  Your name (press Enter to confirm, or type to change): `);
        humanName = answer || detected.humanName;
      } else {
        humanName = await ask("\n  What's your name? ");
      }

      if (!humanName) {
        console.error(pc.red("  Your name is required.\n"));
        process.exit(1);
      }

      if (detected.agentName) {
        console.log(pc.dim(`\n  Detected from ${detected.agentNameSource}: ${pc.bold(detected.agentName)}`));
        const answer = await ask(`  Agent name (press Enter to confirm, or type to change): `);
        agentName = answer || detected.agentName;
      } else {
        agentName = await ask("\n  What should your agent be called? ");
      }

      if (!agentName) {
        console.error(pc.red("  Agent name is required.\n"));
        process.exit(1);
      }
    }

    const agentId = `${slugify(agentName)}-${generateSuffix()}`;
    identity = { agent_id: agentId, human_name: humanName, agent_name: agentName };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2) + "\n");
    console.log(pc.green(`  ✓ Agent ID: ${agentId}`));
    console.log(pc.dim(`  ${agentName} for ${humanName}`));
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

  // Viral loop prompt with clear next steps
  if (joinCode) {
    box([
      pc.bold(`✓ Connected with invite code ${joinCode}!`),
      "",
      "Next steps:",
      "",
      "1. Restart your gateway (required):",
      pc.cyan("   openclaw gateway stop && openclaw gateway"),
      "",
      "2. After restart, an auto-hello is sent to the inviter",
      "",
      "3. Test it! Tell your agent:",
      pc.cyan(`   "Message them: hey, just set up AgentLink!"`),
    ]);
  } else {
    box([
      pc.bold("✓ AgentLink is ready!"),
      "",
      "Next steps:",
      "",
      "1. Restart your gateway (required):",
      pc.cyan("   openclaw gateway stop && openclaw gateway"),
      "",
      "2. Generate an invite to connect with someone:",
      pc.cyan(`   "Generate an AgentLink invite for [Name]"`),
    ]);
  }
  console.log("");
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

  const humanNameIdx = args.indexOf("--human-name");
  const humanNameArg = humanNameIdx >= 0 ? args[humanNameIdx + 1] : undefined;

  const agentNameIdx = args.indexOf("--agent-name");
  const agentNameArg = agentNameIdx >= 0 ? args[agentNameIdx + 1] : undefined;

  setup(joinCode, humanNameArg, agentNameArg);
} else if (command === "uninstall") {
  uninstall();
} else {
  console.log("\n" + pc.bold("  AgentLink CLI") + "\n");
  console.log("  Usage:");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup") + "                              Install + generate identity");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup --join CODE") + "                Install + join via invite");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup --human-name NAME") + "          Specify human name");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup --agent-name NAME") + "          Specify agent name");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink uninstall") + "                        Remove plugin\n");
  console.log("  Options can be combined:");
  console.log("    " + pc.cyan("npx @agentlinkdev/agentlink setup --join CODE --human-name \"Rupul\" --agent-name \"Arya\"") + "\n");
}
