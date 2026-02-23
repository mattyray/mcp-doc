#!/bin/bash
# Exports all relevant source code from mcp-doc into a single text file.
# Usage: ./export.sh [output_file]

OUT="${1:-mcp-doc-export.txt}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

{
  echo "================================================"
  echo "  mcp-doc — Source Code Export"
  echo "  Generated: $(date)"
  echo "================================================"
  echo ""

  # package.json
  echo "════════════════════════════════════════════════"
  echo "  package.json"
  echo "════════════════════════════════════════════════"
  echo ""
  cat "$PROJECT_DIR/package.json"
  echo ""
  echo ""

  # tsconfig.json
  echo "════════════════════════════════════════════════"
  echo "  tsconfig.json"
  echo "════════════════════════════════════════════════"
  echo ""
  cat "$PROJECT_DIR/tsconfig.json"
  echo ""
  echo ""

  # All TypeScript source files
  for f in "$PROJECT_DIR"/src/*.ts; do
    name="src/$(basename "$f")"
    echo "════════════════════════════════════════════════"
    echo "  $name"
    echo "════════════════════════════════════════════════"
    echo ""
    cat "$f"
    echo ""
    echo ""
  done

  # BUILD_LOG.md
  if [ -f "$PROJECT_DIR/BUILD_LOG.md" ]; then
    echo "════════════════════════════════════════════════"
    echo "  BUILD_LOG.md"
    echo "════════════════════════════════════════════════"
    echo ""
    cat "$PROJECT_DIR/BUILD_LOG.md"
    echo ""
    echo ""
  fi

  # CLAUDE.md
  if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
    echo "════════════════════════════════════════════════"
    echo "  CLAUDE.md"
    echo "════════════════════════════════════════════════"
    echo ""
    cat "$PROJECT_DIR/CLAUDE.md"
    echo ""
  fi

} > "$PROJECT_DIR/$OUT"

echo "Exported to $PROJECT_DIR/$OUT"
