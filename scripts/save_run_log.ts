#!/usr/bin/env npx ts-node

/**
 * save_run_log.ts
 *
 * Snapshots the current state of published_posts.json into a
 * timestamped run log for auditing and debugging.
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".claude", "cache");
const PUBLISHED_FILE = path.join(CACHE_DIR, "published_posts.json");
const RUN_LOG_FILE = path.join(CACHE_DIR, "run_log.json");

interface RunLogEntry {
  timestamp: string;
  trigger: string;
  posts_total: number;
  new_posts: any[];
}

function main() {
  if (!fs.existsSync(PUBLISHED_FILE)) {
    console.log("No published_posts.json found. Skipping log.");
    return;
  }

  const published = JSON.parse(fs.readFileSync(PUBLISHED_FILE, "utf-8"));

  let runLog: RunLogEntry[] = [];
  if (fs.existsSync(RUN_LOG_FILE)) {
    runLog = JSON.parse(fs.readFileSync(RUN_LOG_FILE, "utf-8"));
  }

  // Determine new posts since last run
  const lastRunPostCount =
    runLog.length > 0 ? runLog[runLog.length - 1].posts_total : 0;
  const newPosts = published.slice(lastRunPostCount);

  const entry: RunLogEntry = {
    timestamp: new Date().toISOString(),
    trigger: process.env.TRIGGER_SOURCE || "manual",
    posts_total: published.length,
    new_posts: newPosts,
  };

  runLog.push(entry);

  fs.writeFileSync(RUN_LOG_FILE, JSON.stringify(runLog, null, 2));

  console.log(`Run log saved.`);
  console.log(`  Total runs: ${runLog.length}`);
  console.log(`  New posts this run: ${newPosts.length}`);
  console.log(`  Total posts: ${published.length}`);
}

main();
