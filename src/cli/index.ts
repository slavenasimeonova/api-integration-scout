// CLI entry point. The agent core lands in src/core in later commits.
const url = process.argv[2];

if (!url) {
  console.error("Usage: npm run scout -- <docs-url>");
  process.exit(1);
}

console.log(`API Integration Scout: agent core not implemented yet (got ${url})`);
