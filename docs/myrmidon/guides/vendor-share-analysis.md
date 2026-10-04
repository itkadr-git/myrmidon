# Vendor Share Analysis Tool

## Overview
This script analyzes the proportion of vendor-derived files in the Myrmidon repository compared to the original Paperclip base.

## Usage
```bash
# Run analysis with default 50% threshold and output markdown summary
node scripts/myrmidon/vendor-share.mjs

# Run with custom threshold (e.g., 70%)
node scripts/myrmidon/vendor-share.mjs --threshold 0.7

# Output results in JSON format
node scripts/myrmidon/vendor-share.mjs --json

# Show help
node scripts/myrmidon/vendor-share.mjs --help
```

## Configuration
- The script reads the base vendor commit from `scripts/myrmidon/vendor-base.txt`
- Default similarity threshold is 50% (0.5)
- Files matching exclusion patterns are ignored (lock files, build artifacts, etc.)

## Output
The script provides:
- Total number of files in the repository
- Number and percentage of vendor-derived files
- Breakdown by top-level directories
- With `--json`: every vendor-derived file with its similarity ratio

## Logic
A file is considered vendor-derived if:
1. It existed in the base vendor commit
2. The similarity ratio (based on common lines) is above the threshold
3. It is not in the exclusion list

The similarity is calculated by comparing normalized content (normalized line endings, stripped whitespace, no empty lines) and computing the ratio of common lines to the maximum of the two file lengths.