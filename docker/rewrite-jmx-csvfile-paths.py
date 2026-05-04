#!/usr/bin/env python3
"""
JMX Path Rewriter - Replace local CSV paths with container paths.

This script modifies JMX files to replace local file paths (e.g., Windows paths)
with container paths (/tmp/) so JMeter can find data files in the container.

Usage:
    python3 rewrite-jmx-paths.py <jmx_file> [--dry-run]
"""

import sys
import xml.etree.ElementTree as ET
import os
import re


def normalize_csv_path(original_path):
    """
    Convert any local path to container path.
    
    NEW APPROACH (Runtime Partitioning):
    - All containers download the SAME CSV file with ORIGINAL filename
    - NO space replacement - keeps filename exactly as in S3
    - NO container suffix - all containers use same file
    - inject-jmx-partitioning.py adds offset/increment to JMX at runtime
    - Each container reads different rows based on offset/increment
    
    Examples:
        C:/Users/test/data.csv -> /tmp/data.csv
        ./scripts/SSP_API_Test_Data 3.csv -> /tmp/SSP_API_Test_Data 3.csv (KEEPS SPACE!)
        data/users.csv -> /tmp/users.csv
    """
    # Extract just the filename (without directory)
    filename = os.path.basename(original_path)
    
    # Return container path with ORIGINAL filename (no modifications)
    # This matches the S3 file exactly when entrypoint downloads it
    return f"/tmp/{filename}"


def rewrite_jmx_csv_paths(jmx_file, dry_run=False):
    """
    Rewrite CSV file paths in JMX file to use container paths.
    
    Args:
        jmx_file: Path to JMX file
        dry_run: If True, only show what would be changed without modifying file
        
    Returns:
        Number of paths replaced
    """
    print(f"[INFO] Reading JMX file: {jmx_file}")
    
    # Parse JMX file
    try:
        tree = ET.parse(jmx_file)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"[ERROR] Failed to parse JMX file: {e}")
        return 0
    
    replacements = 0
    changes = []
    
    # Find all CSVDataSet elements
    for elem in root.iter():
        if elem.get('testclass') == 'CSVDataSet':
            # Find the filename stringProp
            for prop in elem.findall('.//stringProp'):
                if prop.get('name') == 'filename':
                    original_path = prop.text or ''
                    
                    if original_path:
                        # Generate container path
                        container_path = normalize_csv_path(original_path)
                        
                        # Only replace if different
                        if original_path != container_path:
                            changes.append({
                                'original': original_path,
                                'new': container_path
                            })
                            
                            print(f"  [REPLACE] Replacing:")
                            print(f"      FROM: {original_path}")
                            print(f"      TO:   {container_path}")
                            
                            if not dry_run:
                                prop.text = container_path
                            
                            replacements += 1
    
    # Save modified JMX (if not dry run and changes were made)
    if replacements > 0 and not dry_run:
        print(f"\n[SAVE] Saving modified JMX file...")
        tree.write(jmx_file, encoding='utf-8', xml_declaration=True)
        print(f"[SUCCESS] Successfully rewrote {replacements} CSV path(s)")
    elif dry_run and replacements > 0:
        print(f"\n[DRY RUN] Would rewrite {replacements} CSV path(s)")
    else:
        print(f"\n[INFO] No CSV paths needed to be rewritten")
    
    return replacements


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 rewrite-jmx-paths.py <jmx_file> [--dry-run]")
        print("\nExamples:")
        print("  python3 rewrite-jmx-paths.py /tmp/test.jmx")
        print("  python3 rewrite-jmx-paths.py /tmp/test.jmx --dry-run")
        sys.exit(1)
    
    jmx_file = sys.argv[1]
    dry_run = '--dry-run' in sys.argv
    
    if not os.path.exists(jmx_file):
        print(f"[ERROR] File not found: {jmx_file}")
        sys.exit(1)
    
    print("=" * 60)
    print("JMX CSV Path Rewriter")
    print("=" * 60)
    if dry_run:
        print("[DRY RUN] No changes will be made")
    print()
    
    replacements = rewrite_jmx_csv_paths(jmx_file, dry_run)
    
    print("=" * 60)
    sys.exit(0 if replacements >= 0 else 1)


if __name__ == '__main__':
    main()