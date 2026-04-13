/**
 * Nexus Tool Registry
 *
 * Central export for all built-in tools, organized by category.
 * Total: 40+ tools across 9 categories.
 */

import type { Tool } from "../types.js";

// Category imports
import {
  readFileTool,
  writeFileTool,
  patchFileTool,
  listFilesTool,
  searchFilesTool,
  filesystemTools,
} from "./filesystem.js";

import { shellTool, processStatusTool, terminalTools } from "./terminal.js";

import { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, gitBranchTool, gitTools } from "./git.js";

import { webSearchTool, fetchUrlTool, webTools } from "./web.js";
import type { SearchResult } from "./web.js";

import { runCodeTool, codeTools } from "./code.js";

import { generateImageTool, imageTools } from "./image.js";

import { analyzeImageTool, readTextFromImageTool, visionTools } from "./vision.js";

import {
  screenshotUrlTool,
  scrapePageTool,
  browserClickTool,
  browserFillTool,
  browserEvalTool,
  browserTools,
} from "./browser.js";

import {
  readCsvTool,
  readJsonTool,
  writeJsonTool,
  querySqliteTool,
  readPdfTool,
  readXmlTool,
  dataTools,
} from "./data.js";

import { httpRequestTool, downloadFileTool, checkUrlTool, networkTools } from "./network.js";

import {
  notifyTool,
  clipboardReadTool,
  clipboardWriteTool,
  systemInfoTool,
  openUrlTool,
  zipTool,
  unzipTool,
  getEnvTool,
  systemTools,
} from "./system.js";

// ── All built-in tools ────────────────────────────────────

/** The complete set of built-in tools available to the agent */
export const builtinTools: Tool[] = [
  ...filesystemTools,   // read_file, write_file, patch_file, list_files, search_files
  ...terminalTools,     // shell, process_status
  ...gitTools,          // git_status, git_diff, git_commit, git_log, git_branch
  ...webTools,          // web_search, fetch_url
  ...networkTools,      // http_request, download_file, check_url
  ...codeTools,         // run_code
  ...imageTools,        // generate_image
  ...visionTools,       // analyze_image, read_text_from_image
  ...browserTools,      // screenshot_url, scrape_page, browser_click, browser_fill, browser_eval
  ...dataTools,         // read_csv, read_json, write_json, query_sqlite, read_pdf, read_xml
  ...systemTools,       // notify, clipboard_read, clipboard_write, system_info, open_url, zip, unzip, get_env
];

// ── Re-exports ────────────────────────────────────────────

// Filesystem
export { readFileTool, writeFileTool, patchFileTool, listFilesTool, searchFilesTool, filesystemTools };

// Terminal
export { shellTool, processStatusTool, terminalTools };

// Git
export { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, gitBranchTool, gitTools };

// Web
export { webSearchTool, fetchUrlTool, webTools };
export type { SearchResult };

// Network
export { httpRequestTool, downloadFileTool, checkUrlTool, networkTools };

// Code
export { runCodeTool, codeTools };

// Image generation
export { generateImageTool, imageTools };

// Vision / OCR
export { analyzeImageTool, readTextFromImageTool, visionTools };

// Browser automation
export { screenshotUrlTool, scrapePageTool, browserClickTool, browserFillTool, browserEvalTool, browserTools };

// Data
export { readCsvTool, readJsonTool, writeJsonTool, querySqliteTool, readPdfTool, readXmlTool, dataTools };

// System
export {
  notifyTool, clipboardReadTool, clipboardWriteTool, systemInfoTool,
  openUrlTool, zipTool, unzipTool, getEnvTool, systemTools,
};
