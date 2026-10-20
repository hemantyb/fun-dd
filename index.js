#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "child_process";
import { exec } from "child_process";
import os from "os";

async function main() {
  console.clear();

  // 1. Check sudo permission
  console.log(`${pc.bgYellow(pc.black(" CHECK SUDO "))} ${pc.bold("This tool requires sudo permissions")}\n`);

  const { execSync } = await import("child_process");
  try {
    execSync("whoami");
  } catch {
    p.exit(` ${pc.red("Error:")} This command must be run with sudo. ${pc.bold("Example: sudo fun-dd")} `);
    return;
  }

  // 2. Select ISO path
  const isoPath = await p.text({
    message: "Select the ISO file path:",
    placeholder: "/path/to/iso/file.iso",
    validate(value) {
      if (value.length === 0) return "ISO path is required!";
      if (!value.startsWith("/")) return "Please enter an absolute path!";
      try {
        const fs = await import("fs");
        if (!fs.existsSync(value)) return "ISO file does not exist!";
      } catch {
        return "Cannot check ISO file!";
      }
      return true;
    },
  });

  // 3. Select storage type (e.g., /dev/sdb1, /dev/sda, etc.)
  // Get available block devices
  let blockDevices = [];
  try {
    const { stdout } = await exec("lsblk -dpno NAME");
    const lines = stdout.trim().split("\n");
    blockDevices = lines
      .map((line) => `/dev/${line}`)
      .filter((dev) => dev.startsWith("/dev/sd") || dev.startsWith("/dev/nvme"));
  } catch {
    blockDevices = ["/dev/sdb1", "/dev/sda1", "/dev/sdc1"];
  }

  const storageSelect = await p.select({
    message: "Select the target storage device:",
    options: [
      { value: "/dev/sdb1", label: "/dev/sdb1" },
      { value: "/dev/sda1", label: "/dev/sda1" },
      { value: "/dev/sdc1", label: "/dev/sdc1" },
      ...blockDevices.map((dev) => ({ value: dev, label: dev })),
    ],
  });

  // 4. Block size (bs) selection
  const bsSelect = await p.select({
    message: "Select block size (bs):",
    options: [
      { value: "4M", label: "4M (4 MB)" },
      { value: "1M", label: "1M (1 MB)" },
      { value: "512K", label: "512K" },
      { value: "512B", label: "512B" },
      { value: "100K", label: "100K" },
    ],
  });

  // 5. oflag selection
  const oflagSelect = await p.multiselect({
    message: "Select output flags (oflag):",
    options: [
      { value: "sync", label: "sync" },
      { value: "dsync", label: "dsync (data sync)" },
      { value: "direct", label: "direct (skip buffer cache)" },
      { value: "noerror", label: "noerror (continue on read error)" },
      { value: "notrunc", label: "notrunc (don't truncate output)" },
      { value: "append", label: "append" },
    ],
  });

  // Build oflag string
  const oflag = oflagSelect.length > 0 ? oflagSelect.join(",") : "sync";

  // Confirm before writing to device
  const confirmWrite = await p.confirm({
    message: `Are you sure you want to write ISO to ${storageSelect}?\nThis will overwrite all data on the device!`,
    active: "yes",
    inactive: "no",
  });

  if (!confirmWrite) {
    p.exit(`\n${pc.bgYellow(pc.black(" CANCELLED "))} Operation cancelled by user.`);
    return;
  }

  // 6. Run dd with progress bar
  console.log(`\n${pc.bgCyan(pc.black("  WRITING ISO  "))}\n`);

  const progress = p.progress({
    message: "Writing ISO to device...",
    title: "fun-dd",
  });

  let speed = "0 B/s";
  let eta = "00:00";

  const ddProcess = spawn("dd", [
    `bs=${bsSelect}`,
    `if=${isoPath}`,
    `of=${storageSelect}`,
    `oflag=${oflag}`,
    "status=progress",
  ]);

  let received = 0;
  let startTime = Date.now();

  // Parse dd progress output
  ddProcess.stdout.on("data", (data) => {
    const output = data.toString();
    // dd with status=progress outputs lines like:
    // 8533120 bytes transferred 3.2MB/s 00:00:01 remaining
    const match = output.match(/(\d+) bytes transferred ([\d.]+)(MB|KB|GB)\/s.*?remaining ([\d:]+)/);
    if (match) {
      const [, bytes, value, unit, remaining] = match;
      const units = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
      const speedBytes = parseFloat(value) * (units[unit] || 1);
      received = speedBytes;
      speed = `${parseFloat(value).toFixed(1)} ${unit}/s`;
      eta = remaining;
    }

    // Also handle simpler format with B/s
    const match2 = output.match(/([\d.]+) (MB|KB|GB|B)\/s/);
    if (match2 && !match) {
      const [, value, unit] = match2;
      speed = `${value} ${unit}/s`;
    }
  });

  ddProcess.stderr.on("data", (data) => {
    const output = data.toString();
    // dd status=progress format: "8533120 bytes transferred 3.2MB/s 00:00:01 remaining"
    const match = output.match(/(\d+) bytes transferred ([\d.]+)(MB|KB|GB)\/s.*?remaining ([\d:]+)/);
    if (match) {
      const [, bytes, value, unit, remaining] = match;
      const units = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
      const speedBytes = parseFloat(value) * (units[unit] || 1);
      speed = `${parseFloat(value).toFixed(1)} ${unit}/s`;
      eta = remaining;
    }
    // Update progress bar with partial info if possible
    progress.update({ message: output.trim() });
  });

  // Handle process completion
  const exitCode = await new Promise((resolve) => {
    ddProcess.on("close", (code) => resolve(code));
  });

  progress.stop();

  if (exitCode === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    p.success(
      `\n${pc.bgGreen(pc.black("  SUCCESS  "))} ISO successfully written!\n` +
      `   Speed: ${pc.cyan(speed)}\n` +
      `   Time: ${pc.cyan(elapsed)} seconds\n` +
      `   Device: ${pc.cyan(storageSelect)}\n`
    );
    p.outro(`🎉 ${pc.green("Operation completed successfully!")}`);
  } else {
    p.exit(
      `\n${pc.bgRed(pc.black("  ERROR  "))} dd command failed with exit code: ${exitCode}\n` +
      `   Check that the selected device is correct and not mounted.\n` +
      `   Try different oflag options or check ISO integrity.`
    );
  }
}

main().catch((err) => {
  p.exit(`\n${pc.bgRed(pc.black("  ERROR  "))} Unexpected error: ${err.message}\n`);
  process.exit(1);
});