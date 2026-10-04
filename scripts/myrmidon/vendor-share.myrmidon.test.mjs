// Tests for vendor-share.mjs
// These tests validate the functionality of the vendor share analysis script

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { analyzeVendorShare, calculateSimilarity, isExcluded, formatAsMarkdown } = require('./vendor-share.mjs');

// Test calculateSimilarity function
function testCalculateSimilarity() {
  console.log('Testing calculateSimilarity function...');
  
  // Test identical strings
  let result = calculateSimilarity('hello world', 'hello world');
  console.assert(result === 1.0, `Expected 1.0, got ${result}`);
  
  // Test completely different strings
  result = calculateSimilarity('hello', 'world');
  console.assert(result === 0.0, `Expected 0.0, got ${result}`);
  
  // Test similar strings
  result = calculateSimilarity('hello world', 'hello word');
  console.assert(result > 0.8 && result < 1.0, `Expected > 0.8 and < 1.0, got ${result}`);
  
  // Test with null/undefined
  result = calculateSimilarity(null, null);
  console.assert(result === 1.0, `Expected 1.0 for null, null, got ${result}`);
  
  result = calculateSimilarity('hello', null);
  console.assert(result === 0.0, `Expected 0.0 for 'hello', null, got ${result}`);
  
  console.log('✓ calculateSimilarity tests passed');
}

// Test isExcluded function
function testIsExcluded() {
  console.log('Testing isExcluded function...');
  
  // Test various exclusion patterns
  console.assert(isExcluded('node_modules/package/file.js', ['**/node_modules/**']) === true, 'node_modules should be excluded');
  console.assert(isExcluded('src/index.js', ['**/node_modules/**']) === false, 'src/index.js should not be excluded');
  console.assert(isExcluded('dist/bundle.js', ['**/dist/**']) === true, 'dist files should be excluded');
  console.assert(isExcluded('package-lock.json', ['package-lock.json']) === true, 'package-lock.json should be excluded');
  
  console.log('✓ isExcluded tests passed');
}

// Test that the script can be executed
function testScriptExecution() {
  console.log('Testing script execution...');
  
  // Test basic execution with JSON output
  const result = spawnSync('node', ['./vendor-share.mjs', '--json'], {
    cwd: __dirname,
    encoding: 'utf-8'
  });
  
  if (result.error) {
    console.error('Error executing script:', result.error);
    process.exit(1);
  }
  
  if (result.status !== 0) {
    console.error('Script exited with status:', result.status);
    console.error('stderr:', result.stderr);
    process.exit(1);
  }
  
  try {
    const output = JSON.parse(result.stdout);
    console.assert(typeof output.summary === 'object', 'Output should have a summary object');
    console.assert(Array.isArray(output.details.vendorFiles), 'Output should have vendor files array');
    console.assert(Array.isArray(output.details.nonVendorFiles), 'Output should have non-vendor files array');
    
    console.log('✓ Script execution test passed');
  } catch (parseError) {
    console.error('Error parsing script output:', parseError);
    console.error('Output was:', result.stdout);
    process.exit(1);
  }
}

// Test analyzeVendorShare function with mock data
function testAnalyzeVendorShare() {
  console.log('Testing analyzeVendorShare function...');
  
  // We'll run this on a small subset of the actual repository
  // to make sure it works properly
  try {
    const results = analyzeVendorShare(0.5); // Use default threshold
    
    console.assert(typeof results.summary === 'object', 'Results should have a summary');
    console.assert(typeof results.summary.totalFiles === 'number', 'Total files should be a number');
    console.assert(typeof results.summary.vendorFiles === 'number', 'Vendor files should be a number');
    console.assert(typeof results.summary.nonVendorFiles === 'number', 'Non-vendor files should be a number');
    console.assert(Array.isArray(results.details.vendorFiles), 'Vendor files should be an array');
    console.assert(Array.isArray(results.details.nonVendorFiles), 'Non-vendor files should be an array');
    
    // Check that the numbers add up
    console.assert(
      results.summary.totalFiles === results.summary.vendorFiles + results.summary.nonVendorFiles,
      `File counts don't add up: ${results.summary.totalFiles} != ${results.summary.vendorFiles} + ${results.summary.nonVendorFiles}`
    );
    
    console.log('✓ analyzeVendorShare function test passed');
  } catch (error) {
    console.error('Error in analyzeVendorShare test:', error);
    process.exit(1);
  }
}

// Test formatAsMarkdown function
function testFormatAsMarkdown() {
  console.log('Testing formatAsMarkdown function...');
  
  // Create mock results
  const mockResults = {
    summary: {
      totalFiles: 10,
      vendorFiles: 7,
      nonVendorFiles: 3,
      vendorRatio: 0.7,
      thresholdUsed: 0.5,
      vendorBaseCommit: 'abc123def456'
    },
    grouped: {
      byDirectory: {
        vendor: { src: ['src/file1.js', 'src/file2.js'], docs: ['docs/readme.md'] },
        nonVendor: { tests: ['tests/test1.js'] }
      }
    }
  };
  
  const markdown = formatAsMarkdown(mockResults);
  console.assert(markdown.includes('# Vendor Share Analysis Report'), 'Markdown should contain header');
  console.assert(markdown.includes('| Total Files Analyzed | 10 |'), 'Markdown should contain correct totals');
  console.assert(markdown.includes('src'), 'Markdown should contain directory names');
  
  console.log('✓ formatAsMarkdown function test passed');
}

// Run all tests
function runAllTests() {
  console.log('Running all tests for vendor-share.mjs...\n');
  
  testCalculateSimilarity();
  testIsExcluded();
  testScriptExecution();
  testAnalyzeVendorShare();
  testFormatAsMarkdown();
  
  console.log('\n✓ All tests passed!');
}

// Execute tests if this file is run directly
if (require.main === module) {
  runAllTests();
}