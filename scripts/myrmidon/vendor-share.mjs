#!/usr/bin/env node

// Vendor Share Analysis Script
// Compares files in the current repository with the vendor base commit to determine
// which files are inherited from the vendor based on content similarity.

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Minimatch } = require('minimatch');

// Configuration
const DEFAULT_THRESHOLD = 0.5;
const VENDOR_BASE_FILE = './scripts/myrmidon/vendor-base.txt';

// Default exclusion patterns
const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  'node_modules/**',
  '**/.git/**',
  '.git/**',
  '**/dist/**',
  'dist/**',
  '**/build/**',
  'build/**',
  '**/out/**',
  'out/**',
  '**/target/**',
  'target/**',
  '**/.next/**',
  '.next/**',
  '**/vendor/**',
  'vendor/**',
  '**/third_party/**',
  'third_party/**',
  '**/*.log',
  '*.log',
  '**/package-lock.json',
  'package-lock.json',
  '**/yarn.lock',
  'yarn.lock',
  '**/pnpm-lock.yaml',
  'pnpm-lock.yaml',
  '**/.DS_Store',
  '.DS_Store',
  '**/Thumbs.db',
  'Thumbs.db',
  '**/.idea/**',
  '.idea/**',
  '**/.vscode/**',
  '.vscode/**',
  '**/TODO.md',
  'TODO.md',
  'scripts/myrmidon/vendor-base.txt',
  'docs/myrmidon/DIVERGENCE.md'
];

// Calculate similarity between two strings using a simple algorithm
function calculateSimilarity(str1, str2) {
  if (!str1 && !str2) return 1.0;
  if (!str1 || !str2) return 0.0;
  
  // Normalize strings by removing extra whitespace and standardizing line endings
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const n1 = normalize(str1);
  const n2 = normalize(str2);
  
  if (n1 === n2) return 1.0;
  
  // Simple character-based similarity calculation
  const longer = n1.length > n2.length ? n1 : n2;
  const shorter = n1.length > n2.length ? n2 : n1;
  
  if (longer.length === 0) return 1.0;
  
  // Count common characters at the same positions
  let commonChars = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) {
      commonChars++;
    }
  }
  
  // Use the common character ratio as a simple similarity measure
  return (2.0 * commonChars) / (n1.length + n2.length);
}

// Check if a path matches any of the exclusion patterns
function isExcluded(filePath, excludePatterns) {
  for (const pattern of excludePatterns) {
    const mm = new Minimatch(pattern);
    if (mm.match(filePath)) {
      return true;
    }
  }
  return false;
}

// Get all files in the repository
function getAllFiles() {
  const result = spawnSync('git', ['ls-files'], { encoding: 'utf-8' });
  if (result.error) {
    throw new Error(`Git error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Git command failed: ${result.stderr}`);
  }
  return result.stdout.trim().split('\n').filter(f => f.length > 0);
}

// Get the vendor base commit
function getVendorBaseCommit() {
  if (!fs.existsSync(VENDOR_BASE_FILE)) {
    throw new Error(`Vendor base file does not exist: ${VENDOR_BASE_FILE}`);
  }
  return fs.readFileSync(VENDOR_BASE_FILE, 'utf8').trim();
}

// Get file content from a specific commit
function getFileContentFromCommit(filePath, commitHash) {
  try {
    // Use git show to get the content of the file at the specific commit
    const result = spawnSync('git', ['show', `${commitHash}:${filePath}`], { encoding: 'utf-8' });
    if (result.status !== 0) {
      // File might not exist in the base commit
      return null;
    }
    return result.stdout;
  } catch (error) {
    // File might not exist in the base commit
    return null;
  }
}

// Group files by top-level directory
function groupByTopLevelDir(fileList) {
  const groups = {};
  for (const file of fileList) {
    const parts = file.split('/');
    const topLevelDir = parts[0];
    if (!groups[topLevelDir]) {
      groups[topLevelDir] = [];
    }
    groups[topLevelDir].push(file);
  }
  return groups;
}

// Group files by package (directory structure indicating packages)
function groupByPackage(fileList) {
  const groups = {};
  for (const file of fileList) {
    // Look for package-like structures (e.g., directories with package.json, src/, lib/, etc.)
    const parts = file.split('/');
    let packageName = 'root';
    
    // Try to identify package structure
    if (parts.length > 1) {
      // Common package indicators: directories with specific naming
      for (let i = 1; i < parts.length; i++) {
        if (['packages', 'pkg', 'components', 'modules', 'plugins'].includes(parts[i - 1])) {
          packageName = parts[i];
          break;
        }
      }
    }
    
    if (!groups[packageName]) {
      groups[packageName] = [];
    }
    groups[packageName].push(file);
  }
  return groups;
}

// Main analysis function
function analyzeVendorShare(threshold = DEFAULT_THRESHOLD, excludePatterns = DEFAULT_EXCLUDE_PATTERNS, includeTests = false) {
  console.error('Getting vendor base commit...');
  const vendorBaseCommit = getVendorBaseCommit();
  console.error(`Using vendor base commit: ${vendorBaseCommit}`);

  console.error('Getting all files in repository...');
  const allFiles = getAllFiles();
  console.error(`Found ${allFiles.length} files in repository`);

  // Filter out excluded files
  let filesToAnalyze = allFiles.filter(file => !isExcluded(file, excludePatterns));
  
  // Optionally filter out test files
  if (!includeTests) {
    filesToAnalyze = filesToAnalyze.filter(file => {
      const lowerPath = file.toLowerCase();
      return !(/(\.(test|spec)\.|\/test\/|\/__tests__\/|\.test\.|\._test\.)/.test(lowerPath));
    });
  }

  console.error(`Analyzing ${filesToAnalyze.length} files after exclusions...`);
  
  const vendorFiles = [];
  const nonVendorFiles = [];
  
  for (const filePath of filesToAnalyze) {
    try {
      // Get current file content
      let currentContent;
      try {
        currentContent = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        // Skip files that cannot be read (binary files, etc.)
        console.error(`Skipping unreadable file: ${filePath}`);
        continue;
      }
      
      // Get file content from vendor base commit
      const vendorContent = getFileContentFromCommit(filePath, vendorBaseCommit);
      
      if (vendorContent === null) {
        // File doesn't exist in vendor base commit, so it's not vendor-derived
        nonVendorFiles.push(filePath);
      } else {
        // Calculate similarity
        const similarity = calculateSimilarity(currentContent, vendorContent);
        
        if (similarity >= threshold) {
          // File is vendor-derived
          vendorFiles.push({
            path: filePath,
            similarity: similarity
          });
        } else {
          // File has been modified significantly, so it's not vendor-derived
          nonVendorFiles.push(filePath);
        }
      }
    } catch (error) {
      console.error(`Error processing file ${filePath}: ${error.message}`);
    }
  }

  // Group results
  const vendorFilePaths = vendorFiles.map(item => item.path);
  const vendorByDir = groupByTopLevelDir(vendorFilePaths);
  const vendorByPackage = groupByPackage(vendorFilePaths);
  
  const nonVendorByDir = groupByTopLevelDir(nonVendorFiles);
  const nonVendorByPackage = groupByPackage(nonVendorFiles);

  // Prepare results
  const totalFiles = vendorFiles.length + nonVendorFiles.length;
  const vendorRatio = totalFiles > 0 ? vendorFiles.length / totalFiles : 0;
  
  return {
    summary: {
      totalFiles: totalFiles,
      vendorFiles: vendorFiles.length,
      nonVendorFiles: nonVendorFiles.length,
      vendorRatio: vendorRatio,
      thresholdUsed: threshold,
      vendorBaseCommit: vendorBaseCommit
    },
    details: {
      vendorFiles: vendorFiles,
      nonVendorFiles: nonVendorFiles
    },
    grouped: {
      byDirectory: {
        vendor: vendorByDir,
        nonVendor: nonVendorByDir
      },
      byPackage: {
        vendor: vendorByPackage,
        nonVendor: nonVendorByPackage
      }
    }
  };
}

// Format results as Markdown table
function formatAsMarkdown(results) {
  const { summary, grouped } = results;
  
  let markdown = `# Vendor Share Analysis Report\n\n`;
  markdown += `## Summary\n\n`;
  markdown += `| Metric | Value |\n`;
  markdown += `|--------|-------|\n`;
  markdown += `| Total Files Analyzed | ${summary.totalFiles} |\n`;
  markdown += `| Vendor Files | ${summary.vendorFiles} |\n`;
  markdown += `| Non-Vendor Files | ${summary.nonVendorFiles} |\n`;
  markdown += `| Vendor Share | ${(summary.vendorRatio * 100).toFixed(2)}% |\n`;
  markdown += `| Threshold Used | ${(summary.thresholdUsed * 100).toFixed(2)}% |\n`;
  markdown += `| Base Commit | ${summary.vendorBaseCommit.substring(0, 12)} |\n\n`;
  
  markdown += `## Breakdown by Top-Level Directory\n\n`;
  markdown += `### Vendor Files by Directory\n`;
  markdown += `| Directory | Count |\n`;
  markdown += `|-----------|-------|\n`;
  for (const [dir, files] of Object.entries(grouped.byDirectory.vendor)) {
    markdown += `| ${dir} | ${files.length} |\n`;
  }
  
  markdown += `\n### Non-Vendor Files by Directory\n`;
  markdown += `| Directory | Count |\n`;
  markdown += `|-----------|-------|\n`;
  for (const [dir, files] of Object.entries(grouped.byDirectory.nonVendor)) {
    markdown += `| ${dir} | ${files.length} |\n`;
  }
  
  return markdown;
}

// Main execution
function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let threshold = DEFAULT_THRESHOLD;
  let outputJson = false;
  let includeTests = false;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' || args[i] === '-t') {
      threshold = parseFloat(args[i + 1]);
      if (isNaN(threshold) || threshold < 0 || threshold > 1) {
        console.error('Error: Threshold must be a number between 0 and 1');
        process.exit(1);
      }
      i++; // Skip next argument
    } else if (args[i] === '--json') {
      outputJson = true;
    } else if (args[i] === '--include-tests') {
      includeTests = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node vendor-share.mjs [OPTIONS]

Options:
  --threshold, -t THRESHOLD  Similarity threshold (0.0 to 1.0, default: 0.5)
  --json                     Output in JSON format instead of Markdown
  --include-tests            Include test files in the analysis
  --help, -h                 Show this help message

Example:
  node vendor-share.mjs --threshold 0.7
  node vendor-share.mjs --json
      `);
      process.exit(0);
    }
  }
  
  try {
    console.error('Starting vendor share analysis...');
    const results = analyzeVendorShare(threshold, DEFAULT_EXCLUDE_PATTERNS, includeTests);
    
    if (outputJson) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatAsMarkdown(results));
    }
  } catch (error) {
    console.error(`Error during analysis: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeVendorShare,
  calculateSimilarity,
  isExcluded,
  formatAsMarkdown
};